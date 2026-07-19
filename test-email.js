// Force look at the absolute directory root path first
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const nodemailer = require('nodemailer');

console.log("--- Debugging Injected Keys ---");
// This will print out all available environment keys so you can see if they are named differently
console.log("Available Process Keys:", Object.keys(process.env).filter(key => key.includes('EMAIL') || key.includes('PASS')));

// Fallback checking for common naming variants
const user = process.env.EMAIL_USER || process.env.MAIL_USER || process.env.EMAIL_USER_NAME;
const pass = process.env.EMAIL_PASS || process.env.MAIL_PASS || process.env.EMAIL_PASSWORD;

console.log("\nChecking targeted environment variables...");
console.log("Resolved User:", user);
console.log("Resolved Pass Length:", pass ? pass.length : 0);

if (!user || !pass) {
    console.error("❌ Critical Error: Environment variables are not mapped correctly in process.env. Check your key names!");
    process.exit(1);
}

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
});

mailTransporter.sendMail({
    from: user,
    to: user,
    subject: 'FoldGo SMTP Test Pipeline',
    text: 'If you read this, your SMTP configuration profiles are perfectly functional!'
})
    .then(info => {
        console.log('✅ Success! Email sent cleanly:', info.messageId);
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ SMTP Connection Failure:', err);
        process.exit(1);
    });