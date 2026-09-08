const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// A defined "no content" result the Channel Engine can accept without erroring.
// Returned for channels that have no scheduled clips so an empty channel does not
// produce a 500 on every ~5s webhook poll.
const EMPTY_VOD = Object.freeze({ id: null, title: null, hlsUrl: null, empty: true });

// Throttle the "empty channel" log so it is emitted at most once per channel rather
// than on every poll. Keyed by channelId; value is the last time we logged for it.
const emptyChannelLoggedAt = new Map();
const EMPTY_CHANNEL_LOG_INTERVAL_MS = 60 * 60 * 1000; // at most once per hour per channel

function logEmptyChannelOnce(channelId) {
  const last = emptyChannelLoggedAt.get(channelId);
  const now = Date.now();
  if (last === undefined || now - last >= EMPTY_CHANNEL_LOG_INTERVAL_MS) {
    console.log(
      `Channel ${channelId} has no scheduled clips - returning empty/no-content result (suppressing repeat logs)`
    );
    emptyChannelLoggedAt.set(channelId, now);
  }
}

// `advance` (default true) controls whether the returned position is persisted as the
// channel's lastServedPosition. The engine webhook (/webhook/nextVod) must advance so
// each ~5s poll queues the NEXT clip. Read-only callers such as the /current lookup pass
// { advance: false } so peeking at "what's playing now" does not move the pointer and
// cause the next engine poll to skip a clip.
async function getNextVod(channelId, { advance = true } = {}) {
  try {
    const now = new Date();

    // The Channel Engine polls this endpoint (~every 5s) to obtain the VOD to append
    // NEXT in its VOD2Live loop. We therefore must advance through the schedule by
    // position (1 -> 2 -> 3 -> loop) instead of repeatedly returning the clip whose
    // window happens to span `now` (which re-queues clip 1 forever). We track the last
    // position handed to the engine on the channel and hand out the one after it.
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new Error('No schedule found for channel');
    }

    const lastServedPosition = channel.lastServedPosition;

    // Find the next active item after the last one we served.
    let schedule = null;
    if (lastServedPosition !== null && lastServedPosition !== undefined) {
      schedule = await prisma.schedule.findFirst({
        where: {
          channelId,
          isActive: true,
          position: { gt: lastServedPosition }
        },
        include: { vod: true },
        orderBy: { position: 'asc' }
      });
    }

    // No item after the last served position (or nothing served yet): either loop back
    // to the first item by position, or the channel is empty. Get the first item by
    // position to tell the two cases apart. When we wrap around, rebalance the schedule
    // times so the reported windows stay contiguous from now.
    if (!schedule) {
      schedule = await prisma.schedule.findFirst({
        where: {
          channelId,
          isActive: true
        },
        include: { vod: true },
        orderBy: { position: 'asc' }
      });

      if (schedule && lastServedPosition !== null && lastServedPosition !== undefined) {
        // Genuine loop-back (we had already served something and ran off the end).
        // If nothing was served yet (lastServedPosition null), we simply start at the
        // first item without rebalancing. An empty channel leaves `schedule` null and
        // falls through to the graceful no-content return below.
        console.log(`Reached end of schedule for channel ${channelId}, looping back to position ${schedule.position} at ${now}`);

        const { rebalanceSchedule } = require('./schedulingUtils');

        // Update the channel's schedule start to current time and rebalance times.
        await prisma.channel.update({
          where: { id: channelId },
          data: { scheduleStart: now }
        });
        await rebalanceSchedule(channelId, 1);

        // Re-fetch the (now rebalanced) first item.
        schedule = await prisma.schedule.findFirst({
          where: {
            channelId,
            isActive: true,
            position: schedule.position
          },
          include: { vod: true }
        });
      }
    }

    if (!schedule) {
      // Every lookup (current window, next upcoming, loop-back by position) came up
      // empty, so this channel genuinely has no active scheduled clips. Rather than
      // throwing (which the route turns into a 500 on every poll), return a defined
      // no-content result and log at most once per channel.
      logEmptyChannelOnce(channelId);
      return { ...EMPTY_VOD };
    }

    // Record the position we are handing to the engine so the next poll advances.
    // Skip this for read-only callers (advance: false) so a "what's playing now"
    // lookup does not move the pointer and make the next engine poll skip a clip.
    if (advance) {
      await prisma.channel.update({
        where: { id: channelId },
        data: { lastServedPosition: schedule.position }
      });
    }

    const response = {
      id: schedule.vod.id,
      title: schedule.vod.title,
      hlsUrl: schedule.vod.hlsUrl
    };

    // Add preroll if available
    if (schedule.vod.prerollUrl && schedule.vod.prerollDurationMs) {
      response.prerollUrl = schedule.vod.prerollUrl;
      response.prerollDurationMs = schedule.vod.prerollDurationMs;
    }

    return response;
  } catch (error) {
    console.error('Error getting next VOD:', error);
    throw error;
  }
}

function registerWebhookRoutes(fastify) {
  // Channel Engine webhook endpoint
  fastify.get('/webhook/nextVod', async (request, reply) => {
    try {
      const channelId = request.query.channelId;
      
      if (!channelId) {
        return reply.code(400).send({ error: 'channelId parameter is required' });
      }

      // Verify channel exists - try by ID first, then by name, then by sanitized name
      let channel = await prisma.channel.findUnique({
        where: { id: channelId }
      });

      if (!channel) {
        // Try finding by exact name match (for OSC instance names)
        channel = await prisma.channel.findFirst({
          where: { name: channelId }
        });
      }

      if (!channel) {
        // Try finding by sanitized name - check if any channel's sanitized name matches
        const allChannels = await prisma.channel.findMany();
        channel = allChannels.find(ch => {
          const sanitizedName = ch.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return sanitizedName === channelId;
        });
      }

      if (!channel) {
        return reply.code(404).send({ error: 'Channel not found' });
      }

      // Use the actual channel ID for schedule lookup
      const actualChannelId = channel.id;

      console.log(`Requesting next VOD for channel ${channelId} (actual ID: ${actualChannelId})`);

      const now = new Date();

      // Check if this is the first time the engine is fetching content and sync schedule
      if (!channel.scheduleSynced && channel.scheduleStart) {
        console.log(`First VOD fetch detected for channel ${channelId}, syncing schedule start time`);

        // Update the schedule start time to current time and sync all schedules
        const { updateChannelScheduleStart } = require('./schedulingUtils');
        await updateChannelScheduleStart(actualChannelId, now, false);

        // Mark the channel as synced
        await prisma.channel.update({
          where: { id: actualChannelId },
          data: {
            lastWebhookCall: now,
            scheduleSynced: true
          }
        });

        console.log(`Schedule synced for channel ${channelId} - adjusted start time from ${channel.scheduleStart} to ${now}`);
      } else {
        // Update the channel's last webhook call time to track "online" status
        await prisma.channel.update({
          where: { id: actualChannelId },
          data: { lastWebhookCall: now }
        });
      }
      
      const vodResponse = await getNextVod(actualChannelId);
      return vodResponse;
    } catch (error) {
      console.error('Webhook error:', error);
      return reply.code(500).send({ error: 'Failed to get next VOD' });
    }
  });

  // Health check endpoint
  fastify.get('/webhook/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}

module.exports = { registerWebhookRoutes, getNextVod };