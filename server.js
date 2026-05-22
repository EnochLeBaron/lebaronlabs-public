const express = require("express");
const path = require("path");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/privacy", (req, res) => {
    res.sendFile(path.join(__dirname, "privacy.html"));
});

app.get("/terms", (req, res) => {
    res.sendFile(path.join(__dirname, "terms.html"));
});

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: "Too many requests. Please wait and try again."
    }
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

function cleanText(value) {
    if (!value) return "";
    return String(value).replace(/[<>]/g, "").trim();
}

app.post("/api/contact", contactLimiter, async (req, res) => {
    try {
        const name = cleanText(req.body.name);
        const email = cleanText(req.body.email);
        const phone = cleanText(req.body.phone);
        const timeline = cleanText(req.body.timeline);
        const selectedServices = cleanText(req.body.selectedServices);
        const estimatedCost = cleanText(req.body.estimatedCost);
        const message = cleanText(req.body.message);

        if (!name || !email || !message || !selectedServices) {
            return res.status(400).json({
                success: false,
                message: "Please fill out your name, email, services, and project details."
            });
        }

        const mailOptions = {
            from: `"LeBaronLabs Contact Form" <${process.env.SMTP_USER}>`,
            to: process.env.CONTACT_EMAIL_TO,
            replyTo: email,
            subject: `New Project Request from ${name}`,
            html: `
                <div style="font-family: Arial, sans-serif; background:#f4f7fb; padding:24px;">
                    <div style="max-width:680px; margin:0 auto; background:white; border-radius:18px; overflow:hidden; border:1px solid #dce3ee;">
                        <div style="background:#07111f; color:white; padding:24px;">
                            <h1 style="margin:0; font-size:24px;">New LeBaronLabs Project Request</h1>
                            <p style="margin:8px 0 0; color:#b8c4d6;">A new contact form submission was received.</p>
                        </div>

                        <div style="padding:24px;">
                            <h2 style="font-size:18px; margin:0 0 14px;">Contact Info</h2>

                            <p><strong>Name:</strong> ${name}</p>
                            <p><strong>Email:</strong> ${email}</p>
                            <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
                            <p><strong>Timeline:</strong> ${timeline || "Not provided"}</p>

                            <hr style="border:none; border-top:1px solid #e6ebf2; margin:22px 0;">

                            <h2 style="font-size:18px; margin:0 0 14px;">Selected Services</h2>
                            <p>${selectedServices}</p>

                            <h2 style="font-size:18px; margin:22px 0 14px;">Estimated Cost</h2>
                            <p style="font-size:20px; font-weight:bold; color:#0b6fae;">${estimatedCost || "Not calculated"}</p>

                            <hr style="border:none; border-top:1px solid #e6ebf2; margin:22px 0;">

                            <h2 style="font-size:18px; margin:0 0 14px;">Project Details</h2>
                            <p style="white-space:pre-line; line-height:1.6;">${message}</p>
                        </div>
                    </div>
                </div>
            `,
            text: `
New LeBaronLabs Project Request

Name: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}
Timeline: ${timeline || "Not provided"}

Selected Services:
${selectedServices}

Estimated Cost:
${estimatedCost || "Not calculated"}

Project Details:
${message}
            `
        };

        await transporter.sendMail(mailOptions);

        return res.json({
            success: true,
            message: "Your request was sent successfully."
        });

    } catch (error) {
        console.error("Contact form error:", error);

        return res.status(500).json({
            success: false,
            message: "Something went wrong while sending your request."
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
