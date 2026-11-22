// Gửi email qua API HTTPS của Brevo (Render gói miễn phí chặn SMTP).
// Chưa cấu hình BREVO_API_KEY: chỉ in mã ra terminal để thử nghiệm.

function buildEmail(purpose, code, minutes) {
  const isReset = purpose === 'reset';

  const subject = isReset
    ? 'Mã đặt lại mật khẩu HabitFlow'
    : 'Mã xác thực email HabitFlow';

  const intro = isReset
    ? 'Bạn vừa yêu cầu đặt lại mật khẩu HabitFlow.'
    : 'Cảm ơn bạn đã đăng ký HabitFlow. Dùng mã bên dưới để xác thực email.';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
      <h2 style="color:#172554">HabitFlow</h2>
      <p>${intro}</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#172554">${code}</p>
      <p>Mã có hiệu lực trong ${minutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
    </div>`;

  return { subject, html };
}

async function sendCodeEmail(to, purpose, code, minutes) {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM;
  const { subject, html } = buildEmail(purpose, code, minutes);

  if (!apiKey || !from) {
    console.log(
      `[DEV] Chua cau hinh Brevo. Email gia lap toi ${to} ` +
      `(${purpose}): MA = ${code}`
    );
    return;
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: process.env.MAIL_FROM_NAME || 'HabitFlow',
        email: from
      },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Brevo ${response.status}: ${detail}`);
  }
}

module.exports = { sendCodeEmail };