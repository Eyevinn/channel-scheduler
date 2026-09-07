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

async function getNextVod(channelId) {
  try {
    const now = new Date();
    
    // Find the current or next scheduled item
    let schedule = await prisma.schedule.findFirst({
      where: {
        channelId,
        isActive: true,
        scheduledStart: { lte: now },
        scheduledEnd: { gte: now }
      },
      include: { vod: true },
      orderBy: { scheduledStart: 'asc' }
    });

    // If no current item, get the next one
    if (!schedule) {
      schedule = await prisma.schedule.findFirst({
        where: {
          channelId,
          isActive: true,
          scheduledStart: { gt: now }
        },
        include: { vod: true },
        orderBy: { scheduledStart: 'asc' }
      });
    }

    // If still no item, we're either looping back to the beginning or the channel
    // is empty. Get the first item by position to tell the two cases apart.
    if (!schedule) {
      schedule = await prisma.schedule.findFirst({
        where: {
          channelId,
          isActive: true
        },
        include: { vod: true },
        orderBy: { position: 'asc' }
      });

      if (schedule) {
        // A real loop-back: there are clips, we just ran past the last window.
        console.log(`No upcoming schedule items found for channel ${channelId}, looping back to beginning and updating schedule times`);

        // Update the entire schedule to start from now
        const { rebalanceSchedule } = require('./schedulingUtils');
        
        // Update the channel's schedule start to current time
        await prisma.channel.update({
          where: { id: channelId },
          data: { scheduleStart: now }
        });
        
        // Rebalance all schedule times starting from position 1
        await rebalanceSchedule(channelId, 1);
        
        // Fetch the updated schedule item
        schedule = await prisma.schedule.findFirst({
          where: {
            channelId,
            isActive: true,
            position: schedule.position
          },
          include: { vod: true }
        });
        
        console.log(`Schedule updated for channel ${channelId} - restarted from position 1 at ${now}`);
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