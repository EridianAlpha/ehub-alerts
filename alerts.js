const { ethers } = require("ethers")
const { MongoClient } = require("mongodb")
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns")

require("dotenv").config()

const snsClient = new SNSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
})

async function monitorAlerts() {
    const mongoClient = new MongoClient(process.env.MONGO_URL)
    await mongoClient.connect()
    const database = mongoClient.db("ehub")
    const dbAlertsConfig = database.collection("alertsConfig")
    const dbAlerts = database.collection("alerts")

    // Since only one health check ping is sent, the whole process is wrapped in a try-finally block
    // so if even a single alert check fails, the health check ping is not sent.
    try {
        const alertsConfig = await dbAlertsConfig.find({}).toArray()

        for (const alert of alertsConfig) {
            console.log("Checking alert:", alert.name)

            // Get alert from the DB if it already exists
            const dbAlert = await dbAlerts.findOne({ name: alert.name })

            // Get the new value from the blockchain
            const provider = new ethers.JsonRpcProvider(alert.rpcUrl)

            // Validate the provider by attempting to get the network
            await provider.getNetwork()

            // Create the contract object
            const contract = new ethers.Contract(alert.contractAddress.toString(), [alert.functionAbiString], provider)

            // Call functions with inputs if they exist, otherwise call the function with no inputs
            let response
            if (alert.functionInputs && alert.functionInputs.length > 0) {
                response = await contract[alert.functionName](...alert.functionInputs)
            } else {
                response = await contract[alert.functionName]()
            }

            if (!dbAlert || dbAlert.value != response) {
                // If the values have changed, try to update the DB first
                console.log(`Updating value ${alert.name}`)
                console.log(`Old value: ${!dbAlert ? null : dbAlert.value}`)
                console.log(`New Value: ${response}`)

                await dbAlerts.updateOne(
                    { name: alert.name },
                    {
                        $set: {
                            value: response,
                            timestamp: new Date(),
                        },
                    },
                    { upsert: true } // Use upsert to insert the document if it doesn't exist
                )

                await snsClient.send(
                    new PublishCommand({
                        Subject: `EHub Alert: ${alert.name}`,
                        Message: `${alert.name} has changed!\nOld value: ${!dbAlert ? null : dbAlert.value}\nNew Value: ${response}`,
                        TopicArn: process.env.AWS_SNS_TOPIC_ARN,
                    })
                )
                console.log("SNS Notification sent successfully for:", alert.name)
                console.log("------------------------------------------------------")
            }
        }
    } finally {
        await mongoClient.close()

        console.log("All alerts checked successfully - Sending health check ping")
        await fetch(`https://hc-ping.com/${process.env.HC_PING_SLUG}`)
    }
}

monitorAlerts()
