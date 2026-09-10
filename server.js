require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const GRAPH_VERSION =
    process.env.META_GRAPH_VERSION || "v25.0";

const DATA_FILE =
    path.join(__dirname, "data.json");


// ==================================================
// APP
// ==================================================

app.use(express.json({
    limit: "5mb"
}));


// ==================================================
// DATA STORAGE
// ==================================================

function loadData() {

    try {

        if (!fs.existsSync(DATA_FILE)) {

            return {
                campaigns: []
            };
        }

        const raw =
            fs.readFileSync(
                DATA_FILE,
                "utf8"
            );

        return JSON.parse(raw);

    } catch (error) {

        console.error(
            "Data load error:",
            error
        );

        return {
            campaigns: []
        };
    }
}


function saveData(data) {

    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}


let database = loadData();


// ==================================================
// HELPERS
// ==================================================

function generateId(prefix) {

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(4)
            .toString("hex")
    );
}


function normalizePhone(phone) {

    return String(phone || "")
        .replace(/\D/g, "");
}


function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}


function verifyMetaSignature(req) {

    const appSecret =
        process.env.META_APP_SECRET;

    // During initial testing, if APP SECRET
    // is not configured, allow the webhook.
    if (!appSecret) {
        return true;
    }

    const signature =
        req.headers["x-hub-signature-256"];

    if (!signature) {
        return false;
    }

    const expected =
        "sha256=" +
        crypto
            .createHmac(
                "sha256",
                appSecret
            )
            .update(
                JSON.stringify(req.body)
            )
            .digest("hex");

    try {

        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );

    } catch {

        return false;
    }
}


// ==================================================
// BASIC ROUTES
// ==================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message:
            "SharpWhatsApp Backend is running"
    });
});


app.get("/health", (req, res) => {

    res.json({
        success: true,
        status: "OK"
    });
});


app.get("/config-status", (req, res) => {

    res.json({

        success: true,

        accessTokenConfigured:
            Boolean(
                process.env.META_ACCESS_TOKEN
            ),

        phoneNumberIdConfigured:
            Boolean(
                process.env.META_PHONE_NUMBER_ID
            ),

        graphVersion:
            GRAPH_VERSION,

        webhookVerifyTokenConfigured:
            Boolean(
                process.env.META_WEBHOOK_VERIFY_TOKEN
            ),

        webhookSignatureConfigured:
            Boolean(
                process.env.META_APP_SECRET
            )
    });
});


// ==================================================
// SEND SINGLE TEST MESSAGE
// ==================================================

app.post("/send-test", async (req, res) => {

    try {

        const {
            recipient,
            templateName =
                "3p_direct_integration_test_template",
            language = "en_US"
        } = req.body;


        const phone =
            normalizePhone(recipient);


        if (!phone) {

            return res.status(400).json({

                success: false,

                error:
                    "recipient is required"
            });
        }


        if (!process.env.META_ACCESS_TOKEN) {

            return res.status(500).json({

                success: false,

                error:
                    "META_ACCESS_TOKEN is not configured"
            });
        }


        if (!process.env.META_PHONE_NUMBER_ID) {

            return res.status(500).json({

                success: false,

                error:
                    "META_PHONE_NUMBER_ID is not configured"
            });
        }


        const result =
            await sendTemplateMessage(
                phone,
                templateName,
                language
            );


        if (!result.success) {

            return res.status(
                result.status || 500
            ).json(result);
        }


        return res.json({

            success: true,

            message:
                "Message accepted by Meta API",

            meta:
                result.data
        });


    } catch (error) {

        console.error(
            "Send test error:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                error.message
        });
    }
});


// ==================================================
// META SEND FUNCTION
// ==================================================

async function sendTemplateMessage(
    recipient,
    templateName,
    language
) {

    const url =
        `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.META_PHONE_NUMBER_ID}/messages`;


    const response =
        await fetch(
            url,
            {

                method: "POST",

                headers: {

                    "Authorization":
                        `Bearer ${process.env.META_ACCESS_TOKEN}`,

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify({

                        messaging_product:
                            "whatsapp",

                        to:
                            recipient,

                        type:
                            "template",

                        template: {

                            name:
                                templateName,

                            language: {

                                code:
                                    language
                            }
                        }
                    })
            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        console.error(
            "Meta API Error:",
            JSON.stringify(
                data,
                null,
                2
            )
        );


        return {

            success: false,

            status:
                response.status,

            data
        };
    }


    return {

        success: true,

        status:
            response.status,

        data
    };
}


// ==================================================
// CREATE CAMPAIGN
// ==================================================

app.post("/campaigns", (req, res) => {

    try {

        const {
            name,
            templateName,
            language = "en_US",
            recipients
        } = req.body;


        if (!name) {

            return res.status(400).json({

                success: false,

                error:
                    "Campaign name is required"
            });
        }


        if (!templateName) {

            return res.status(400).json({

                success: false,

                error:
                    "Template name is required"
            });
        }


        if (
            !Array.isArray(recipients) ||
            recipients.length === 0
        ) {

            return res.status(400).json({

                success: false,

                error:
                    "recipients must be a non-empty array"
            });
        }


        const cleanedRecipients =
            recipients
                .map(item => {

                    const phone =
                        normalizePhone(
                            typeof item === "string"
                                ? item
                                : item.phone
                        );


                    const optIn =
                        typeof item === "string"
                            ? true
                            : item.optIn !== false;


                    const optedOut =
                        typeof item === "string"
                            ? false
                            : item.optedOut === true;


                    return {

                        phone,

                        optIn,

                        optedOut,

                        status:
                            "pending",

                        wamid:
                            null,

                        error:
                            null,

                        sentAt:
                            null,

                        deliveredAt:
                            null,

                        readAt:
                            null,

                        failedAt:
                            null
                    };
                })
                .filter(item =>
                    item.phone.length >= 10
                );


        if (
            cleanedRecipients.length === 0
        ) {

            return res.status(400).json({

                success: false,

                error:
                    "No valid phone numbers found"
            });
        }


        const campaign = {

            id:
                generateId("campaign"),

            name,

            templateName,

            language,

            createdAt:
                new Date().toISOString(),

            startedAt:
                null,

            completedAt:
                null,

            status:
                "draft",

            recipients:
                cleanedRecipients
        };


        database.campaigns.push(
            campaign
        );

        saveData(database);


        return res.status(201).json({

            success: true,

            message:
                "Campaign created",

            campaign: {

                id:
                    campaign.id,

                name:
                    campaign.name,

                templateName:
                    campaign.templateName,

                language:
                    campaign.language,

                totalRecipients:
                    campaign.recipients.length,

                status:
                    campaign.status
            }
        });


    } catch (error) {

        console.error(
            "Create campaign error:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                error.message
        });
    }
});


// ==================================================
// GET ALL CAMPAIGNS
// ==================================================

app.get("/campaigns", (req, res) => {

    const campaigns =
        database.campaigns
            .map(campaign => {

                return {

                    id:
                        campaign.id,

                    name:
                        campaign.name,

                    templateName:
                        campaign.templateName,

                    language:
                        campaign.language,

                    createdAt:
                        campaign.createdAt,

                    startedAt:
                        campaign.startedAt,

                    completedAt:
                        campaign.completedAt,

                    status:
                        campaign.status,

                    total:
                        campaign.recipients.length,

                    pending:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "pending"
                        ).length,

                    accepted:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "accepted"
                        ).length,

                    sent:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "sent"
                        ).length,

                    delivered:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "delivered"
                        ).length,

                    read:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "read"
                        ).length,

                    failed:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "failed"
                        ).length,

                    optedOut:
                        campaign.recipients.filter(
                            r =>
                                r.status ===
                                "opted_out"
                        ).length
                };
            });


    res.json({

        success: true,

        campaigns
    });
});


// ==================================================
// GET ONE CAMPAIGN
// ==================================================

app.get(
    "/campaigns/:id",
    (req, res) => {

        const campaign =
            database.campaigns.find(
                c =>
                    c.id ===
                    req.params.id
            );


        if (!campaign) {

            return res.status(404).json({

                success: false,

                error:
                    "Campaign not found"
            });
        }


        return res.json({

            success: true,

            campaign
        });
    }
);


// ==================================================
// SEND CAMPAIGN
// ==================================================

app.post(
    "/campaigns/:id/send",
    async (req, res) => {

        const campaign =
            database.campaigns.find(
                c =>
                    c.id ===
                    req.params.id
            );


        if (!campaign) {

            return res.status(404).json({

                success: false,

                error:
                    "Campaign not found"
            });
        }


        if (
            campaign.status ===
            "sending"
        ) {

            return res.status(409).json({

                success: false,

                error:
                    "Campaign is already sending"
            });
        }


        if (
            campaign.status ===
            "completed"
        ) {

            return res.status(409).json({

                success: false,

                error:
                    "Campaign is already completed"
            });
        }


        campaign.status =
            "sending";

        campaign.startedAt =
            new Date().toISOString();


        saveData(database);


        // Respond immediately.
        res.json({

            success: true,

            message:
                "Campaign sending started",

            campaignId:
                campaign.id
        });


        // Continue sending in background.
        processCampaign(campaign.id);
    }
);


// ==================================================
// CAMPAIGN PROCESSOR
// ==================================================

async function processCampaign(
    campaignId
) {

    const campaign =
        database.campaigns.find(
            c =>
                c.id ===
                campaignId
        );


    if (!campaign) {
        return;
    }


    console.log(
        `Starting campaign ${campaign.id}`
    );


    for (
        let i = 0;
        i < campaign.recipients.length;
        i++
    ) {

        const recipient =
            campaign.recipients[i];


        // Already processed.
        if (
            recipient.status !==
            "pending"
        ) {
            continue;
        }


        // Respect opt-out.
        if (
            recipient.optedOut === true
        ) {

            recipient.status =
                "opted_out";

            saveData(database);

            continue;
        }


        // Require opt-in.
        if (
            recipient.optIn !== true
        ) {

            recipient.status =
                "failed";

            recipient.error =
                "Recipient has no confirmed opt-in";

            recipient.failedAt =
                new Date().toISOString();

            saveData(database);

            continue;
        }


        try {

            console.log(
                `Sending ${i + 1}/${campaign.recipients.length}: ${recipient.phone}`
            );


            const result =
                await sendTemplateMessage(
                    recipient.phone,
                    campaign.templateName,
                    campaign.language
                );


            if (!result.success) {

                recipient.status =
                    "failed";

                recipient.error =
                    JSON.stringify(
                        result.data
                    );

                recipient.failedAt =
                    new Date().toISOString();

            } else {

                recipient.status =
                    "accepted";

                recipient.wamid =
                    result.data
                        ?.messages?.[0]?.id ||
                    null;

                recipient.sentAt =
                    new Date().toISOString();
            }


            saveData(database);


        } catch (error) {

            recipient.status =
                "failed";

            recipient.error =
                error.message;

            recipient.failedAt =
                new Date().toISOString();

            saveData(database);
        }


        // Small delay to avoid hammering the API.
        // Webhook status remains authoritative.
        await sleep(500);
    }


    campaign.status =
        "completed";

    campaign.completedAt =
        new Date().toISOString();


    saveData(database);


    console.log(
        `Campaign ${campaign.id} completed`
    );
}


// ==================================================
// META WEBHOOK VERIFICATION
// ==================================================

app.get(
    "/webhook",
    (req, res) => {

        const mode =
            req.query["hub.mode"];

        const token =
            req.query["hub.verify_token"];

        const challenge =
            req.query["hub.challenge"];


        const verifyToken =
            process.env
                .META_WEBHOOK_VERIFY_TOKEN;


        if (
            mode === "subscribe" &&
            token === verifyToken
        ) {

            console.log(
                "Meta webhook verification successful."
            );

            return res
                .status(200)
                .send(challenge);
        }


        console.log(
            "Meta webhook verification failed."
        );


        return res.sendStatus(403);
    }
);


// ==================================================
// META WEBHOOK EVENTS
// ==================================================

app.post(
    "/webhook",
    (req, res) => {

        console.log(
            "----------------------------------------"
        );

        console.log(
            "META WEBHOOK RECEIVED"
        );

        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        console.log(
            "----------------------------------------"
        );


        // Verify Meta signature when APP SECRET
        // has been configured.
        if (!verifyMetaSignature(req)) {

            console.error(
                "Invalid Meta webhook signature."
            );

            return res.sendStatus(403);
        }


        try {

            processWebhookEvent(
                req.body
            );

        } catch (error) {

            console.error(
                "Webhook processing error:",
                error
            );
        }


        // Always acknowledge quickly.
        return res.sendStatus(200);
    }
);


// ==================================================
// PROCESS WEBHOOK EVENT
// ==================================================

function processWebhookEvent(
    body
) {

    if (
        body.object !==
        "whatsapp_business_account"
    ) {
        return;
    }


    const entries =
        body.entry || [];


    for (const entry of entries) {

        const changes =
            entry.changes || [];


        for (const change of changes) {

            const value =
                change.value || {};


            // ------------------------------------------
            // MESSAGE STATUS UPDATES
            // ------------------------------------------

            const statuses =
                value.statuses || [];


            for (
                const statusEvent
                of statuses
            ) {

                updateMessageStatus(
                    statusEvent
                );
            }


            // ------------------------------------------
            // INCOMING MESSAGES
            // ------------------------------------------

            const messages =
                value.messages || [];


            for (
                const incoming
                of messages
            ) {

                console.log(
                    "Incoming WhatsApp message:",
                    JSON.stringify(
                        incoming,
                        null,
                        2
                    )
                );
            }
        }
    }
}


// ==================================================
// UPDATE MESSAGE STATUS
// ==================================================

function updateMessageStatus(
    statusEvent
) {

    const wamid =
        statusEvent.id;


    const status =
        statusEvent.status;


    const timestamp =
        statusEvent.timestamp;


    if (!wamid) {
        return;
    }


    for (
        const campaign
        of database.campaigns
    ) {

        const recipient =
            campaign.recipients.find(
                r =>
                    r.wamid ===
                    wamid
            );


        if (!recipient) {
            continue;
        }


        if (
            [
                "sent",
                "delivered",
                "read"
            ].includes(status)
        ) {

            recipient.status =
                status;


            const date =
                timestamp
                    ? new Date(
                        Number(timestamp) *
                        1000
                    ).toISOString()
                    : new Date()
                        .toISOString();


            if (
                status ===
                "sent"
            ) {
                recipient.sentAt =
                    date;
            }


            if (
                status ===
                "delivered"
            ) {
                recipient.deliveredAt =
                    date;
            }


            if (
                status ===
                "read"
            ) {
                recipient.readAt =
                    date;
            }


        } else if (
            status ===
            "failed"
        ) {

            recipient.status =
                "failed";


            recipient.failedAt =
                new Date()
                    .toISOString();


            recipient.error =
                JSON.stringify(
                    statusEvent.errors ||
                    "Message failed"
                );
        }


        saveData(database);


        console.log(
            `Updated ${wamid} -> ${status}`
        );


        return;
    }


    console.log(
        `No campaign found for wamid ${wamid}`
    );
}


// ==================================================
// START SERVER
// ==================================================

app.listen(
    PORT,
    () => {

        console.log(
            `SharpWhatsApp Backend running on http://localhost:${PORT}`
        );

        console.log(
            `Graph API version: ${GRAPH_VERSION}`
        );
    }
);