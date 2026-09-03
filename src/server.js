// Configure body limit based on environment - keep small for chunked uploads
const getBodyLimit = () => {
  if (process.env.MAX_UPLOAD_SIZE) {
    return parseInt(process.env.MAX_UPLOAD_SIZE);
  }
  // Keep small to work with reverse proxies, chunked upload handles large files
  return 10 * 1024 * 1024; // 10MB default
};

const fastify = require('fastify')({ 
  logger: true,
  bodyLimit: getBodyLimit(),
  requestTimeout: 300000 // 5 minute timeout for chunk uploads
});
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const { registerWebhookRoutes } = require('./webhook');
const { getHLSDuration, validateHLSUrl } = require('./hlsUtils');
const { calculateBackToBackSchedule, rebalanceSchedule, updateChannelScheduleStart } = require('./schedulingUtils');
const { seedDatabase } = require('./seedData');
const { OSCClient } = require('./oscClient');

// Utility function to sanitize filenames for upload
function sanitizeFilename(filename) {
  if (!filename) return filename;
  
  // Get file extension
  const lastDotIndex = filename.lastIndexOf('.');
  const name = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
  const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex) : '';
  
  // Replace problematic characters with safe alternatives
  const sanitizedName = name
    .replace(/\s+/g, '_')           // Replace spaces with underscores
    .replace(/[^\w\-_.]/g, '')      // Remove special characters, keep word chars, hyphens, underscores, dots
    .replace(/_{2,}/g, '_')         // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '')       // Remove leading/trailing underscores
    .toLowerCase();                 // Convert to lowercase for consistency
  
  return sanitizedName + extension;
}

const prisma = new PrismaClient();
const oscClient = new OSCClient();

// Utility function to get the public URL
function getPublicUrl() {
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    return publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl;
  }
  return 'http://localhost:3000';
}

// Setup MinIO instance with input and output buckets
async function setupMinioForScheduler(instanceName = 'schedulerstorage', username = 'admin', password = null) {
  if (!oscClient.isConfigured()) {
    console.log('OSC not configured - skipping MinIO setup');
    return null;
  }

  try {
    console.log('Setting up MinIO instance for scheduler...');
    
    // Check if instance already exists
    let minioConfig;
    try {
      minioConfig = await oscClient.getMinioInstance(instanceName);
      console.log(`MinIO instance '${instanceName}' already exists and is running`);
    } catch (error) {
      // Instance doesn't exist or is not running, create it
      console.log(`MinIO instance '${instanceName}' not found or not running, creating new instance...`);
      console.log(`Error details: ${error.message}`);
      minioConfig = await oscClient.createMinioInstance(instanceName, username, password);
    }

    // Create buckets
    console.log('Creating input and output buckets...');
    const bucketResults = await oscClient.createMinioBuckets(
      minioConfig, 
      ['input', 'output'], 
      true // Make output bucket public
    );

    // Don't let a failed bucket be swallowed: createMinioBuckets records
    // per-bucket failures in its results instead of throwing, so a startup that
    // could not create its storage would otherwise look healthy. Surface it.
    const failedBuckets = (bucketResults || []).filter((r) => !r.success);
    if (failedBuckets.length > 0) {
      const detail = failedBuckets
        .map((r) => `${r.bucket}: ${r.error}`)
        .join('; ');
      throw new Error(`MinIO bucket setup failed for: ${detail}`);
    }

    console.log('MinIO setup completed:', {
      instance: minioConfig.instanceName,
      endpoint: minioConfig.endpoint,
      buckets: bucketResults
    });

    return {
      minioConfig,
      bucketResults
    };
  } catch (error) {
    console.error('Failed to setup MinIO for scheduler:', error);
    throw error;
  }
}

fastify.register(require('@fastify/cors'), {
  origin: true
});

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, '../public'),
  prefix: '/'
});

// Configure multipart limits for chunked uploads
const getMultipartLimits = () => {
  const maxChunkSize = process.env.MAX_CHUNK_SIZE ? 
    parseInt(process.env.MAX_CHUNK_SIZE) : 
    8 * 1024 * 1024; // Default 8MB max chunk size

  return {
    fileSize: maxChunkSize, // Max per chunk
    files: 1,
    fieldNameSize: 200,
    fieldSize: 1000,    
    fields: 10,
    headerPairs: 2000
  };
};

fastify.register(require('@fastify/multipart'), {
  limits: getMultipartLimits()
});

// Register webhook routes
registerWebhookRoutes(fastify);

// Channels endpoints
fastify.get('/api/channels', async (request, reply) => {
  try {
    const channels = await prisma.channel.findMany({
      include: { _count: { select: { schedules: true } } }
    });
    return channels;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch channels' });
  }
});

fastify.post('/api/channels', async (request, reply) => {
  try {
    const { name, description, scheduleStart, autoSchedule } = request.body;
    
    // Automatically generate webhook URL
    const publicUrl = getPublicUrl();
    const webhookUrl = `${publicUrl}/webhook/nextVod`;
    
    const channel = await prisma.channel.create({
      data: {
        name,
        description,
        webhookUrl,
        scheduleStart: scheduleStart ? new Date(scheduleStart) : null,
        autoSchedule: autoSchedule !== undefined ? autoSchedule : true,
        scheduleSynced: false
      }
    });
    return channel;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to create channel' });
  }
});

fastify.get('/api/channels/:id', async (request, reply) => {
  try {
    const channel = await prisma.channel.findUnique({
      where: { id: request.params.id },
      include: { schedules: { include: { vod: true }, orderBy: { position: 'asc' } } }
    });
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    return channel;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch channel' });
  }
});

fastify.put('/api/channels/:id', async (request, reply) => {
  try {
    const { name, description, scheduleStart, autoSchedule } = request.body;
    
    // Automatically generate webhook URL (in case PUBLIC_URL changed)
    const publicUrl = getPublicUrl();
    const webhookUrl = `${publicUrl}/webhook/nextVod`;
    
    const updateData = {
      name,
      description,
      webhookUrl,
      autoSchedule: autoSchedule !== undefined ? autoSchedule : undefined
    };

    // If schedule start time is being updated, reset the sync flag
    if (scheduleStart !== undefined) {
      updateData.scheduleStart = scheduleStart ? new Date(scheduleStart) : null;
      updateData.scheduleSynced = false;
    }

    const channel = await prisma.channel.update({
      where: { id: request.params.id },
      data: updateData
    });
    return channel;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to update channel' });
  }
});

fastify.delete('/api/channels/:id', async (request, reply) => {
  try {
    const { id } = request.params;

    // Get the channel first to check if it has a Channel Engine instance
    const channel = await prisma.channel.findUnique({
      where: { id }
    });

    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }

    // If channel has a Channel Engine instance, delete it first
    if (channel.channelEngineInstance && oscClient.isConfigured()) {
      try {
        console.log(`Deleting Channel Engine instance "${channel.channelEngineInstance}" for channel "${channel.name}"`);
        await oscClient.deleteChannelEngineInstance(channel.channelEngineInstance);
        console.log(`Channel Engine instance "${channel.channelEngineInstance}" deleted successfully`);
      } catch (engineError) {
        console.error('Error deleting Channel Engine instance:', engineError);
        // Continue with channel deletion even if engine deletion fails
        // This prevents orphaned channels when the engine might already be deleted
      }
    }

    // Delete the channel (this will cascade delete schedules due to foreign key constraints)
    await prisma.channel.delete({
      where: { id }
    });

    console.log(`Channel "${channel.name}" and associated resources deleted successfully`);

    return { 
      success: true,
      message: `Channel "${channel.name}" deleted successfully`,
      deletedChannelEngine: channel.channelEngineInstance || null
    };
  } catch (error) {
    console.error('Error deleting channel:', error);
    reply.code(500).send({ error: 'Failed to delete channel' });
  }
});

// Get webhook URL for a channel
fastify.get('/api/channels/:id/webhook-url', async (request, reply) => {
  try {
    const { id } = request.params;
    const channel = await prisma.channel.findUnique({
      where: { id }
    });
    
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    
    const publicUrl = getPublicUrl();
    // Channel Engine will automatically append ?channelId=<instanceName> parameter
    const webhookUrl = `${publicUrl}/webhook/nextVod`;
    
    return { webhookUrl };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to get webhook URL' });
  }
});

// Global webhook URL endpoint (same for all channels)
fastify.get('/api/webhook-url', async (request, reply) => {
  try {
    const publicUrl = getPublicUrl();
    // Channel Engine will automatically append ?channelId=<instanceName> parameter
    const webhookUrl = `${publicUrl}/webhook/nextVod`;
    
    return { webhookUrl };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to get webhook URL' });
  }
});

// VODs endpoints
fastify.get('/api/vods', async (request, reply) => {
  try {
    const vods = await prisma.vOD.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return vods;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch VODs' });
  }
});

fastify.post('/api/vods', async (request, reply) => {
  try {
    const { title, description, hlsUrl, durationMs, prerollUrl, prerollDurationMs, metadata } = request.body;
    
    // Auto-detect duration if not provided
    let finalDurationMs = durationMs;
    if (!finalDurationMs && hlsUrl) {
      console.log(`Auto-detecting duration for VOD: ${title}`);
      finalDurationMs = await getHLSDuration(hlsUrl);
    }
    
    const vod = await prisma.vOD.create({
      data: {
        title,
        description,
        hlsUrl,
        durationMs: finalDurationMs,
        prerollUrl,
        prerollDurationMs,
        metadata: metadata ? JSON.stringify(metadata) : null
      }
    });
    return vod;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to create VOD' });
  }
});

fastify.get('/api/vods/:id', async (request, reply) => {
  try {
    const vod = await prisma.vOD.findUnique({
      where: { id: request.params.id }
    });
    if (!vod) {
      return reply.code(404).send({ error: 'VOD not found' });
    }
    if (vod.metadata) {
      vod.metadata = JSON.parse(vod.metadata);
    }
    return vod;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch VOD' });
  }
});

fastify.put('/api/vods/:id', async (request, reply) => {
  try {
    const { title, description, hlsUrl, durationMs, prerollUrl, prerollDurationMs, metadata } = request.body;
    const vod = await prisma.vOD.update({
      where: { id: request.params.id },
      data: {
        title,
        description,
        hlsUrl,
        durationMs,
        prerollUrl,
        prerollDurationMs,
        metadata: metadata ? JSON.stringify(metadata) : null
      }
    });
    return vod;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to update VOD' });
  }
});

fastify.delete('/api/vods/:id', async (request, reply) => {
  try {
    await prisma.vOD.delete({
      where: { id: request.params.id }
    });
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to delete VOD' });
  }
});

// Chunked upload endpoint for large files  
// Store for tracking multipart uploads
const multipartUploads = new Map();

// Initialize multipart upload
fastify.post('/api/upload-init', async (request, reply) => {
  try {
    const { filename } = request.body;
    
    if (!filename) {
      return reply.code(400).send({ error: 'Filename is required' });
    }

    // Check if MinIO is configured
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'MinIO not configured. OSC_ACCESS_TOKEN required.' });
    }

    // Get MinIO configuration
    let minioConfig;
    try {
      minioConfig = await oscClient.getMinioInstance('schedulerstorage');
    } catch (error) {
      return reply.code(500).send({ error: 'MinIO instance not available' });
    }

    // Configure S3 client for MinIO
    const AWS = require('aws-sdk');
    const s3 = new AWS.S3({
      endpoint: minioConfig.endpoint,
      accessKeyId: minioConfig.rootUser,
      secretAccessKey: minioConfig.rootPassword,
      region: minioConfig.region,
      s3ForcePathStyle: true,
      signatureVersion: 'v4'
    });

    // Create unique filename for this upload
    const timestamp = Date.now();
    const uploadId = `${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
    const sanitizedFilename = sanitizeFilename(filename);
    const finalFilename = `${timestamp}-${sanitizedFilename}`;

    // Initialize multipart upload in S3
    const multipartParams = {
      Bucket: 'input',
      Key: finalFilename,
      ContentType: 'application/octet-stream'
    };

    const multipartUpload = await s3.createMultipartUpload(multipartParams).promise();
    
    // Store upload info for tracking
    multipartUploads.set(uploadId, {
      s3UploadId: multipartUpload.UploadId,
      filename: finalFilename,
      originalName: filename,
      bucket: 'input',
      parts: [],
      s3Client: s3
    });

    return reply.send({
      success: true,
      uploadId,
      s3UploadId: multipartUpload.UploadId,
      filename: finalFilename
    });
  } catch (error) {
    console.error('Failed to initialize upload:', error);
    reply.code(500).send({ error: 'Failed to initialize upload' });
  }
});

// Upload individual chunk using S3 multipart
fastify.post('/api/upload-chunk', async (request, reply) => {
  try {
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({ error: 'No chunk uploaded' });
    }

    // Extract fields using a more robust approach
    let chunkIndex, totalChunks, uploadId;
    
    // Parse fields from the multipart data
    if (data.fields) {
      const fields = data.fields;
      
      // Handle different field formats
      const getField = (name) => {
        const field = fields[name];
        if (!field) return undefined;
        return field.value !== undefined ? field.value : field;
      };
      
      chunkIndex = parseInt(getField('chunkIndex'));
      totalChunks = parseInt(getField('totalChunks'));
      uploadId = getField('uploadId');
    }
    
    if (chunkIndex === undefined || isNaN(chunkIndex) || !totalChunks || isNaN(totalChunks) || !uploadId) {
      return reply.code(400).send({ 
        error: 'Missing required chunk metadata',
        received: { chunkIndex, totalChunks, uploadId }
      });
    }

    // Get upload info
    const uploadInfo = multipartUploads.get(uploadId);
    if (!uploadInfo) {
      return reply.code(400).send({ error: 'Upload not initialized. Call /api/upload-init first.' });
    }

    // Upload this part to S3 multipart upload
    const partNumber = chunkIndex + 1; // S3 part numbers are 1-based
    
    // Convert FileStream to Buffer for AWS SDK
    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const chunkBuffer = Buffer.concat(chunks);
    
    const uploadPartParams = {
      Bucket: uploadInfo.bucket,
      Key: uploadInfo.filename,
      PartNumber: partNumber,
      UploadId: uploadInfo.s3UploadId,
      Body: chunkBuffer
    };

    const partResult = await uploadInfo.s3Client.uploadPart(uploadPartParams).promise();
    
    // Store part info
    uploadInfo.parts[chunkIndex] = {
      ETag: partResult.ETag,
      PartNumber: partNumber
    };
    
    // If this is the last chunk, complete the multipart upload
    if (chunkIndex + 1 === totalChunks) {
      // Ensure all parts are present
      const completeParts = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!uploadInfo.parts[i]) {
          return reply.code(400).send({ error: `Missing part ${i}` });
        }
        completeParts.push(uploadInfo.parts[i]);
      }

      // Complete the multipart upload
      const completeParams = {
        Bucket: uploadInfo.bucket,
        Key: uploadInfo.filename,
        UploadId: uploadInfo.s3UploadId,
        MultipartUpload: {
          Parts: completeParts
        }
      };

      const result = await uploadInfo.s3Client.completeMultipartUpload(completeParams).promise();
      
      // Clean up tracking data
      multipartUploads.delete(uploadId);

      // Verify final file
      const headResult = await uploadInfo.s3Client.headObject({
        Bucket: uploadInfo.bucket,
        Key: uploadInfo.filename
      }).promise();
      
      return reply.send({
        success: true,
        filename: uploadInfo.filename,
        originalName: uploadInfo.originalName,
        size: headResult.ContentLength,
        url: result.Location,
        s3Key: result.Key,
        isComplete: true,
        chunked: true
      });
    }
    
    // Return progress for non-final chunks
    return reply.send({
      success: true,
      chunkIndex,
      uploaded: chunkIndex + 1,
      total: totalChunks,
      isComplete: false
    });
    
  } catch (error) {
    console.error('Chunk upload failed:', error);
    reply.code(500).send({ error: 'Failed to upload chunk: ' + error.message });
  }
});

// File upload endpoint for VODs (small files and fallback)
fastify.post('/api/upload-file', async (request, reply) => {
  try {
    // Check if MinIO is configured
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'MinIO not configured. OSC_ACCESS_TOKEN required.' });
    }

    // Get the uploaded file
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    // Get MinIO configuration
    let minioConfig;
    try {
      minioConfig = await oscClient.getMinioInstance('schedulerstorage');
    } catch (error) {
      return reply.code(500).send({ error: 'MinIO instance not available. Please set up MinIO first.' });
    }

    // Configure S3 client for MinIO with smaller chunk sizes
    const AWS = require('aws-sdk');
    
    // Configure multipart upload options for deployment environments
    const partSize = process.env.S3_PART_SIZE ? 
      parseInt(process.env.S3_PART_SIZE) : 
      5 * 1024 * 1024; // Default 5MB parts
    
    const queueSize = process.env.S3_QUEUE_SIZE ? 
      parseInt(process.env.S3_QUEUE_SIZE) : 
      4; // Default 4 concurrent uploads
    
    const s3 = new AWS.S3({
      endpoint: minioConfig.endpoint,
      accessKeyId: minioConfig.rootUser,
      secretAccessKey: minioConfig.rootPassword,
      region: minioConfig.region,
      s3ForcePathStyle: true,
      signatureVersion: 'v4',
      // Configure for smaller chunks
      maxRetries: 3,
      retryDelayOptions: {
        customBackoff: function(retryCount) {
          return Math.pow(2, retryCount) * 1000;
        }
      }
    });

    // Generate unique filename
    const timestamp = Date.now();
    const originalName = data.filename || 'uploaded-file';
    const sanitizedFilename = sanitizeFilename(originalName);
    const filename = `${timestamp}-${sanitizedFilename}`;

    // Use managed upload with smaller parts for deployment environments
    const uploadParams = {
      Bucket: 'input',
      Key: filename,
      Body: data.file,
      ContentType: data.mimetype || 'application/octet-stream'
    };

    // Configure multipart upload options
    const uploadOptions = {
      partSize: partSize,
      queueSize: queueSize
    };

    // Use managed upload with progress tracking and smaller chunks
    const upload = s3.upload(uploadParams, uploadOptions);
    
    upload.on('httpUploadProgress', (progress) => {
      // Progress tracking for potential future use
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      console.log(`Upload progress: ${percentage}%`);
    });
    
    const result = await upload.promise();

    // Verify the file is fully uploaded and accessible
    console.log(`Verifying upload completion for ${filename}...`);
    let retries = 0;
    const maxRetries = 15; // Increased for larger files
    let lastSize = 0;
    let stableChecks = 0;
    
    while (retries < maxRetries) {
      try {
        const headResult = await s3.headObject({
          Bucket: 'input',
          Key: filename
        }).promise();
        
        console.log(`File size check ${retries + 1}: ${headResult.ContentLength} bytes`);
        
        // Check if file size is stable (same size for 2 consecutive checks)
        if (headResult.ContentLength > 0) {
          if (headResult.ContentLength === lastSize) {
            stableChecks++;
            if (stableChecks >= 2) {
              console.log(`Upload verified: ${headResult.ContentLength} bytes stable`);
              break;
            }
          } else {
            stableChecks = 0; // Reset if size changed
          }
          lastSize = headResult.ContentLength;
        }
      } catch (error) {
        console.log(`File not yet available, retrying... (${retries + 1}/${maxRetries})`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for multipart upload completion
      retries++;
    }
    
    if (retries >= maxRetries) {
      throw new Error('File upload verification failed - file may not be fully uploaded');
    }
    
    // Get final file size for response
    const finalHead = await s3.headObject({
      Bucket: 'input', 
      Key: filename
    }).promise();
    
    return {
      success: true,
      filename: filename,
      originalName: originalName,
      size: finalHead.ContentLength,
      mimetype: data.mimetype,
      url: result.Location,
      s3Key: result.Key
    };

  } catch (error) {
    console.error('File upload failed:', error);
    reply.code(500).send({ error: 'Failed to upload file' });
  }
});

// Transcoding endpoints
fastify.post('/api/transcode-file', async (request, reply) => {
  try {
    const { filename, originalName } = request.body;
    
    if (!filename) {
      return reply.code(400).send({ error: 'filename is required' });
    }

    // Check if MinIO is configured
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'OSC not configured for transcoding' });
    }

    // Get MinIO configuration
    let minioConfig;
    try {
      minioConfig = await oscClient.getMinioInstance('schedulerstorage');
    } catch (error) {
      return reply.code(500).send({ error: 'MinIO instance not available for transcoding' });
    }

    // Generate job name and output path (alphanumeric only)
    const timestamp = Date.now();
    const jobName = `transcode${timestamp}`;
    const outputPath = `${filename.replace(/\.[^/.]+$/, "")}`; // Remove extension for output folder
    
    // Create transcoding job
    const transcodingJob = await oscClient.createTranscodingJob(
      jobName,
      filename,
      outputPath,
      minioConfig
    );

    // Generate the expected HLS URL after transcoding
    const hlsUrl = `${minioConfig.endpoint}/output/${outputPath}/master.m3u8`;

    return {
      success: true,
      jobId: transcodingJob.jobId,
      status: transcodingJob.status,
      hlsUrl: hlsUrl,
      inputFile: filename,
      outputPath: outputPath
    };

  } catch (error) {
    console.error('Transcoding job creation failed:', error);
    reply.code(500).send({ error: 'Failed to create transcoding job' });
  }
});

fastify.get('/api/transcode-status/:jobId', async (request, reply) => {
  try {
    const { jobId } = request.params;

    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'OSC not configured' });
    }

    const jobStatus = await oscClient.getTranscodingJobStatus(jobId);
    
    return {
      jobId: jobStatus.jobId,
      status: jobStatus.status,
      oscStatus: jobStatus.oscStatus
    };

  } catch (error) {
    console.error('Failed to get transcoding status:', error);
    reply.code(500).send({ error: 'Failed to get transcoding status' });
  }
});

fastify.delete('/api/transcode-job/:jobId', async (request, reply) => {
  try {
    const { jobId } = request.params;

    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'OSC not configured' });
    }

    const result = await oscClient.deleteTranscodingJob(jobId);
    
    return result;

  } catch (error) {
    console.error('Failed to delete transcoding job:', error);
    reply.code(500).send({ error: 'Failed to delete transcoding job' });
  }
});

// Schedule endpoints
fastify.get('/api/channels/:channelId/schedule', async (request, reply) => {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { channelId: request.params.channelId },
      include: { vod: true },
      orderBy: { position: 'asc' }
    });
    return schedules;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch schedule' });
  }
});

// Get currently playing item using webhook logic
fastify.get('/api/channels/:channelId/current', async (request, reply) => {
  try {
    const { getNextVod } = require('./webhook');
    const currentVod = await getNextVod(request.params.channelId);
    return currentVod;
  } catch (error) {
    console.error('Error getting current item:', error);
    reply.code(500).send({ error: 'Failed to get current item' });
  }
});

fastify.post('/api/channels/:channelId/schedule', async (request, reply) => {
  try {
    const { vodId, scheduledStart, scheduledEnd, position, repeatPattern, useBackToBack } = request.body;
    const channelId = request.params.channelId;
    
    let finalScheduledStart, finalScheduledEnd, finalPosition;
    
    if (useBackToBack !== false) {
      // Use back-to-back scheduling by default
      const backToBackData = await calculateBackToBackSchedule(channelId, vodId, scheduledStart);
      finalScheduledStart = backToBackData.scheduledStart;
      finalScheduledEnd = backToBackData.scheduledEnd;
      finalPosition = position || backToBackData.position;
    } else {
      // Use manual scheduling
      const maxPosition = await prisma.schedule.aggregate({
        where: { channelId },
        _max: { position: true }
      });
      
      finalScheduledStart = new Date(scheduledStart);
      finalScheduledEnd = new Date(scheduledEnd);
      finalPosition = position || (maxPosition._max.position || 0) + 1;
    }
    
    const schedule = await prisma.schedule.create({
      data: {
        channelId,
        vodId,
        scheduledStart: finalScheduledStart,
        scheduledEnd: finalScheduledEnd,
        position: finalPosition,
        repeatPattern
      },
      include: { vod: true }
    });
    return schedule;
  } catch (error) {
    console.error('Error creating schedule entry:', error);
    reply.code(500).send({ error: 'Failed to create schedule entry' });
  }
});

fastify.put('/api/schedule/:id', async (request, reply) => {
  try {
    const { vodId, scheduledStart, scheduledEnd, position, repeatPattern, isActive } = request.body;
    const schedule = await prisma.schedule.update({
      where: { id: request.params.id },
      data: {
        vodId,
        scheduledStart: scheduledStart ? new Date(scheduledStart) : undefined,
        scheduledEnd: scheduledEnd ? new Date(scheduledEnd) : undefined,
        position,
        repeatPattern,
        isActive
      },
      include: { vod: true }
    });
    return schedule;
  } catch (error) {
    reply.code(500).send({ error: 'Failed to update schedule entry' });
  }
});

fastify.delete('/api/schedule/:id', async (request, reply) => {
  try {
    await prisma.schedule.delete({
      where: { id: request.params.id }
    });
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to delete schedule entry' });
  }
});

// Reorder schedule
fastify.put('/api/channels/:channelId/schedule/reorder', async (request, reply) => {
  try {
    const { scheduleIds } = request.body;
    
    const updates = scheduleIds.map((id, index) =>
      prisma.schedule.update({
        where: { id },
        data: { position: index + 1 }
      })
    );
    
    await Promise.all(updates);
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to reorder schedule' });
  }
});

// Rebalance schedule with back-to-back timing
fastify.put('/api/channels/:channelId/schedule/rebalance', async (request, reply) => {
  try {
    const { startFromPosition } = request.body;
    await rebalanceSchedule(request.params.channelId, startFromPosition || 1);
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to rebalance schedule' });
  }
});

// Update channel schedule start time
fastify.put('/api/channels/:channelId/schedule-start', async (request, reply) => {
  try {
    const { scheduleStart } = request.body;
    await updateChannelScheduleStart(request.params.channelId, scheduleStart);
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to update schedule start time' });
  }
});

// Auto-detect VOD duration endpoint
fastify.post('/api/vods/detect-duration', async (request, reply) => {
  try {
    const { hlsUrl } = request.body;
    if (!hlsUrl) {
      return reply.code(400).send({ error: 'hlsUrl is required' });
    }
    
    const durationMs = await getHLSDuration(hlsUrl);
    return { durationMs, durationSeconds: Math.round(durationMs / 1000) };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to detect duration' });
  }
});

// MinIO management endpoints
fastify.post('/api/setup-minio', async (request, reply) => {
  try {
    const { instanceName, username, password } = request.body;
    const name = instanceName ? instanceName.replace(/[^a-z0-9]/g, '') : 'schedulerstorage';
    const user = username || 'admin';
    
    const result = await setupMinioForScheduler(name, user, password);
    
    if (!result) {
      return reply.code(400).send({ error: 'OSC not configured' });
    }
    
    return reply.send({
      success: true,
      instance: result.minioConfig.instanceName,
      endpoint: result.minioConfig.endpoint,
      buckets: result.bucketResults
    });
  } catch (error) {
    console.error('Failed to setup MinIO:', error);
    reply.code(500).send({ error: 'Failed to setup MinIO instance' });
  }
});

fastify.get('/api/minio-config', async (request, reply) => {
  try {
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'OSC not configured' });
    }
    
    const instanceName = 'schedulerstorage';
    const config = await oscClient.getMinioInstance(instanceName);
    
    return reply.send({
      instance: config.instanceName,
      endpoint: config.endpoint,
      region: config.region
    });
  } catch (error) {
    console.error('Failed to get MinIO config:', error);
    reply.code(404).send({ error: 'MinIO instance not found' });
  }
});

// Channel Engine management endpoints
fastify.post('/api/channels/:id/channel-engine', async (request, reply) => {
  try {
    const { id } = request.params;
    const { schedulerUrl } = request.body;
    
    if (!schedulerUrl) {
      return reply.code(400).send({ error: 'schedulerUrl is required' });
    }
    
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    
    // Create Channel Engine instance name from channel name (alphanumeric only)
    const instanceName = channel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const webhookUrl = `${schedulerUrl}/webhook/nextVod`;
    
    // Create Channel Engine instance via OSC API
    let result;
    try {
      if (oscClient.isConfigured()) {
        console.log('Creating Channel Engine instance via OSC API...');
        result = await oscClient.createChannelEngineInstance(instanceName, webhookUrl);
      } else {
        console.log('OSC_ACCESS_TOKEN not configured, using simulation mode...');
        result = await oscClient.simulateChannelEngineCreation(instanceName, webhookUrl);
      }
    } catch (oscError) {
      console.error('Failed to create Channel Engine via OSC API:', oscError);
      throw new Error(`Failed to create Channel Engine instance: ${oscError.message}`);
    }
    
    await prisma.channel.update({
      where: { id },
      data: {
        channelEngineInstance: result.instanceName,
        channelEngineUrl: result.channelEngineUrl,
        webhookUrl: result.webhookUrl,
        lastStatusCheck: new Date()
      }
    });
    
    return { 
      instanceName: result.instanceName, 
      channelEngineUrl: result.channelEngineUrl, 
      webhookUrl: result.webhookUrl,
      message: result.simulated ? 'Channel Engine instance created successfully (simulated)' : 'Channel Engine instance created successfully',
      simulated: result.simulated || false
    };
  } catch (error) {
    console.error('Error creating Channel Engine:', error);
    reply.code(500).send({ error: 'Failed to create Channel Engine instance' });
  }
});

fastify.delete('/api/channels/:id/channel-engine', async (request, reply) => {
  try {
    const { id } = request.params;
    
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    
    if (!channel.channelEngineInstance) {
      return reply.code(400).send({ error: 'No Channel Engine instance found for this channel' });
    }
    
    // Delete Channel Engine instance via OSC API
    const instanceName = channel.channelEngineInstance;
    let result;
    try {
      if (oscClient.isConfigured()) {
        console.log('Deleting Channel Engine instance via OSC API...');
        result = await oscClient.deleteChannelEngineInstance(instanceName);
      } else {
        console.log('OSC_ACCESS_TOKEN not configured, skipping Channel Engine deletion...');
        result = { success: false, reason: 'OSC not configured', simulated: true };
      }
    } catch (oscError) {
      console.error('Failed to delete Channel Engine via OSC API:', oscError);
      // Continue with database cleanup even if OSC API fails
      console.log('Proceeding with database cleanup...');
    }

    // Update database to remove Channel Engine references
    await prisma.channel.update({
      where: { id },
      data: {
        channelEngineInstance: null,
        channelEngineUrl: null,
        webhookUrl: null,
        isOnAir: false,
        lastStatusCheck: null
      }
    });
    
    return { 
      message: result && result.simulated ? 
        'Channel Engine instance deleted successfully (simulated)' : 
        'Channel Engine instance deleted successfully',
      simulated: result ? result.simulated || false : false
    };
  } catch (error) {
    console.error('Error deleting Channel Engine:', error);
    reply.code(500).send({ error: 'Failed to delete Channel Engine instance' });
  }
});

// Link existing Channel Engine instance to channel
fastify.post('/api/channels/:id/channel-engine/link', async (request, reply) => {
  try {
    const { id } = request.params;
    const { instanceName } = request.body;

    if (!instanceName) {
      return reply.code(400).send({ error: 'Instance name is required' });
    }

    // Check if OSC is configured
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ error: 'OSC not configured' });
    }

    // Get the channel
    const channel = await prisma.channel.findUnique({
      where: { id }
    });

    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }

    // Check if channel already has an engine
    if (channel.channelEngineInstance) {
      return reply.code(400).send({ error: 'Channel already has a Channel Engine instance' });
    }

    // Get the webhook URL for this channel
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    const webhookUrl = `${publicUrl}/webhook/nextVod`;

    // Update the channel with the linked engine
    const updatedChannel = await prisma.channel.update({
      where: { id },
      data: {
        channelEngineInstance: instanceName,
        webhookUrl: webhookUrl
      }
    });

    console.log(`Linked existing Channel Engine "${instanceName}" to channel "${channel.name}"`);

    reply.send({
      message: 'Channel Engine linked successfully',
      instanceName,
      webhookUrl,
      channel: updatedChannel
    });

  } catch (error) {
    console.error('Error linking Channel Engine:', error);
    reply.code(500).send({ error: 'Failed to link Channel Engine' });
  }
});

// List all Channel Engine instances
fastify.get('/api/channel-engines', async (request, reply) => {
  try {
    if (!oscClient.isConfigured()) {
      return reply.code(400).send({ 
        error: 'OSC not configured', 
        message: 'OSC_ACCESS_TOKEN environment variable is not set' 
      });
    }

    const instances = await oscClient.listChannelEngineInstances();
    return instances;
  } catch (error) {
    console.error('Error listing Channel Engine instances:', error);
    reply.code(500).send({ error: 'Failed to list Channel Engine instances' });
  }
});

fastify.get('/api/channels/:id/status', async (request, reply) => {
  try {
    const { id } = request.params;
    
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    
    if (!channel.channelEngineInstance) {
      return { isOnAir: false, status: 'no_engine' };
    }
    
    let isOnAir = false;
    let status = 'offline';
    let statusDetails = {};
    
    // Check if Channel Engine is "online" based on recent webhook calls
    // Consider online if webhook was called within last 2 minutes
    const webhookOnlineThreshold = 2 * 60 * 1000; // 2 minutes in milliseconds
    const now = new Date();
    let isWebhookOnline = false;
    
    if (channel.lastWebhookCall) {
      const timeSinceLastWebhook = now - new Date(channel.lastWebhookCall);
      isWebhookOnline = timeSinceLastWebhook <= webhookOnlineThreshold;
      statusDetails.lastWebhookCall = channel.lastWebhookCall;
      statusDetails.timeSinceLastWebhook = timeSinceLastWebhook;
      statusDetails.isWebhookOnline = isWebhookOnline;
    }
    
    // Enrich the reported status string via the OSC API. This is treated as
    // enrichment only: the OSC instance object does not carry a health field,
    // so it must not be the sole source of truth for isOnAir (see #13).
    let oscStatusString = null;
    if (oscClient.isConfigured()) {
      try {
        const oscStatus = await oscClient.getChannelEngineStatus(channel.channelEngineInstance);
        if (!oscStatus.error) {
          if (oscStatus.status) {
            oscStatusString = oscStatus.status;
          }
          statusDetails = { oscStatus: oscStatus.details };
        }
      } catch (oscError) {
        console.error('Failed to get OSC status:', oscError);
      }
    }

    // Primary signal: is the Channel Engine stream reachable? A reachable
    // manifest means the channel is on air, regardless of whether OSC is
    // configured — the OSC call above only enriches the status string.
    if (channel.channelEngineUrl) {
      try {
        const response = await fetch(channel.channelEngineUrl, { method: 'HEAD' });
        const streamAccessible = response.ok;

        isOnAir = streamAccessible;
        status = streamAccessible ? 'on_air' : 'offline';
        statusDetails.streamAccessible = streamAccessible;
      } catch (error) {
        statusDetails.streamError = error.message;
        isOnAir = false;
        status = 'error';
      }
    }

    // Additional positive signal: a recent webhook call confirms the channel is
    // live even if the stream check above did not mark it on air. Never used to
    // force isOnAir false — only to rescue it to true.
    if (isWebhookOnline && !isOnAir) {
      status = 'online_webhook';
      isOnAir = true;
    }

    // If OSC provided a meaningful status string, surface it (unless a positive
    // webhook rescue already set a more specific one).
    if (oscStatusString && status !== 'online_webhook') {
      statusDetails.oscStatusString = oscStatusString;
    }
    
    // Update status in database
    await prisma.channel.update({
      where: { id },
      data: {
        isOnAir,
        lastStatusCheck: new Date()
      }
    });
    
    return { 
      isOnAir, 
      status,
      lastCheck: new Date().toISOString(),
      streamUrl: channel.channelEngineUrl,
      instanceName: channel.channelEngineInstance,
      ...statusDetails
    };
  } catch (error) {
    console.error('Error checking channel status:', error);
    reply.code(500).send({ error: 'Failed to check channel status' });
  }
});

// Global flag to track setup state
let isSettingUpStorage = false;
// Records the last storage-setup failure so it isn't silently swallowed — a
// startup that couldn't create its buckets must not look healthy.
let storageSetupError = null;

// Setup page HTML
const setupPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Setting up Storage</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #3498db;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 2s linear infinite;
            margin: 20px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .progress {
            margin-top: 20px;
            font-size: 14px;
            color: #666;
        }
    </style>
    <script>
        setTimeout(() => {
            window.location.reload();
        }, 10000);
    </script>
</head>
<body>
    <div class="container">
        <h2>Setting up storage instance</h2>
        <div class="spinner"></div>
        <p>Creating MinIO storage and buckets...</p>
        <div class="progress">This may take a few moments</div>
        <p><small>This page will automatically refresh in 10 seconds</small></p>
    </div>
</body>
</html>`;

// Check OSC configuration status
fastify.get('/api/osc-status', async (request, reply) => {
  try {
    return {
      configured: oscClient.isConfigured(),
      features: {
        upload: oscClient.isConfigured(),
        transcode: oscClient.isConfigured(),
        channelEngines: oscClient.isConfigured()
      }
    };
  } catch (error) {
    reply.code(500).send({ error: 'Failed to check OSC status' });
  }
});

// Report storage-setup health so a failed startup is visible instead of silent.
fastify.get('/api/storage/status', async (request, reply) => {
  const ready = !isSettingUpStorage && !storageSetupError;
  if (!ready && storageSetupError) {
    reply.code(503);
  }
  return {
    settingUp: isSettingUpStorage,
    ready,
    error: storageSetupError
  };
});

// Global preHandler for setup mode
fastify.addHook('preHandler', async (request, reply) => {
  if (isSettingUpStorage && !request.url.startsWith('/api/')) {
    reply.type('text/html').send(setupPageHtml);
  }
});

const start = async () => {
  try {
    // Start server first
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    console.log(`Server listening on http://localhost:${process.env.PORT || 3000}`);
    
    // Seed database with sample VODs if empty
    await seedDatabase();

    // Setup MinIO instance if OSC_ACCESS_TOKEN is provided
    if (process.env.OSC_ACCESS_TOKEN) {
      isSettingUpStorage = true;
      try {
        await setupMinioForScheduler();
        storageSetupError = null;
        console.log('MinIO storage setup completed');
      } catch (error) {
        // Surface loudly at error level and keep the failure visible via the
        // /api/storage/status endpoint rather than swallowing it as a warning.
        storageSetupError = error.message;
        console.error('MinIO setup FAILED during startup — storage is not ready:', error);
      }
      isSettingUpStorage = false;
    }

  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = { fastify, start };