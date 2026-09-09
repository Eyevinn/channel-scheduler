const { PrismaClient } = require('@prisma/client');
const { getHLSDuration } = require('./hlsUtils');

const prisma = new PrismaClient();

const sampleVODs = [
    {
        title: "Encore Shaka Demo Audio",
        description: "Demo video processed with Encore and Shaka packager with audio track",
        hlsUrl: "https://vod.demo.osaas.io/mcp-encore-shaka-demo-audio-fylcn/index.m3u8"
    },
    {
        title: "Create FAST Channel Demo", 
        description: "Demo video showcasing how to create a FAST channel",
        hlsUrl: "https://vod.demo.osaas.io/mcp-create-fast-channel-h0qgt/index.m3u8"
    },
    {
        title: "Live Encoding Demo",
        description: "Demo video showing live encoding capabilities",
        hlsUrl: "https://vod.demo.osaas.io/mcp-live-encoding-jawzp/index.m3u8"
    },
    {
        title: "HLS Monitor Demo",
        description: "Demo video demonstrating HLS stream monitoring",
        hlsUrl: "https://vod.demo.osaas.io/mcp-hls-monitor-qt10y/index.m3u8"
    },
    {
        title: "Web Runner Demo",
        description: "Demo video showcasing web runner functionality",
        hlsUrl: "https://vod.demo.osaas.io/mcp-web-runner-jgne4/index.m3u8"
    }
];

async function seedDatabase() {
    try {
        console.log('Checking if VOD library is empty...');
        
        const existingVODs = await prisma.vOD.count();
        
        if (existingVODs > 0) {
            console.log(`VOD library already has ${existingVODs} entries, skipping seed`);
            return;
        }
        
        console.log('VOD library is empty, seeding with sample videos...');
        
        for (const vodData of sampleVODs) {
            console.log(`Processing: ${vodData.title}`);
            
            try {
                // Auto-detect duration from HLS manifest
                const detection = await getHLSDuration(vodData.hlsUrl);
                const durationMs = detection.durationMs;
                console.log(`Detected duration: ${Math.round(durationMs / 1000)}s (${detection.source})`);

                await prisma.vOD.create({
                    data: {
                        title: vodData.title,
                        description: vodData.description,
                        hlsUrl: vodData.hlsUrl,
                        durationMs: durationMs
                    }
                });

                console.log(`✓ Added: ${vodData.title}`);
            } catch (error) {
                // Detection failed: skip seeding this asset entirely rather than
                // persisting a placeholder duration for a dead manifest.
                console.error(`Failed to process ${vodData.title}:`, error.message);
                console.warn(`✗ Skipped: ${vodData.title} (duration could not be determined)`);
            }
        }
        
        console.log('Database seeded successfully!');
    } catch (error) {
        console.error('Error seeding database:', error);
    } finally {
        await prisma.$disconnect();
    }
}

module.exports = { seedDatabase };

if (require.main === module) {
    seedDatabase();
}