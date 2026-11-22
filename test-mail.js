require('dotenv').config();
const { sendCodeEmail } = require('./mailer');

const to = process.argv[2];

if (!to) {
  console.log('Cach dung: node test-mail.js dia-chi@gmail.com');
  process.exit(1);
}

sendCodeEmail(to, 'verify', '123456', 15)
  .then(() => console.log('Xong. Neu da cau hinh Brevo, kiem tra hop thu va Spam.'))
  .catch((error) => console.error('Loi:', error.message));