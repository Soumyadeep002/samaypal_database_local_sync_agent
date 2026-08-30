const { loadConfig } = require("./config");
const { validateMongorestore, pollForSync } = require("./sync");

async function main() {
    console.log("=========================================");
    console.log(" MongoDB Local Sync Agent");
    console.log("=========================================");

    let config;
    try {
        config = loadConfig();
        console.log(`AWS Server: ${config.awsApiUrl}`);
        console.log(`Local MongoDB: ${config.localMongoDisplayUri}`);
        console.log("✓ Configuration loaded");
        await validateMongorestore(config);
        console.log("✓ mongorestore detected");
    } catch (error) {
        console.error(`✗ ${error.message}`);
        process.exitCode = 1;
        return;
    }

    console.log("✓ AWS agent authentication configured");
    console.log("✓ Waiting for synchronization...");
    await pollForSync(config);
}

main().catch((error) => {
    console.error("Local sync agent stopped:", error.message);
    process.exitCode = 1;
});
