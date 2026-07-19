require('dotenv').config();
const nodemailer = require('nodemailer');

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
});

console.log("Checking environment variables...");
console.log("User:", process.env.EMAIL_USER);
console.log("Pass Length:", process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 0);

mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER, // Send a test email to yourself
    subject: 'FoldGo SMTP Test Profile Pipeline',
    text: 'If you read this, your SMTP app settings are perfectly functional!'
})
    .then(info => {
        console.log('✅ Success! Email sent cleanly:', info.messageId);
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ SMTP Connection Failure:', err);
        process.exit(1);
    });