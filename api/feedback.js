/**
 * Feedback handler — sends issue/feature request to itsankur88@gmail.com via Resend
 */

const TO = "ankish.1106@gmail.com";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { type, email, message } = req.body || {};

  if (!type || !message?.trim()) {
    return res.status(400).json({ error: "type and message are required" });
  }

  const subject = type === "issue"
    ? "🐛 [Sparrow] Issue Report"
    : "✨ [Sparrow] Feature Request";

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <h2 style="margin-bottom:4px">${subject}</h2>
      <p style="color:#888;font-size:13px;margin-top:0">Submitted via sparrow-eramishras-projects.vercel.app</p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr>
          <td style="padding:8px 0;color:#888;width:100px">Type</td>
          <td style="padding:8px 0;font-weight:600">${type === "issue" ? "🐛 Bug / Issue" : "✨ Feature Request"}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#888">From</td>
          <td style="padding:8px 0">${email?.trim() || "<em>not provided</em>"}</td>
        </tr>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
      <p style="font-size:13px;color:#888;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Message</p>
      <p style="font-size:15px;line-height:1.7;white-space:pre-wrap">${message.trim()}</p>
    </div>
  `;

  try {
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Sparrow Feedback <onboarding@resend.dev>",
        to: [TO],
        reply_to: email?.trim() || undefined,
        subject,
        html,
      }),
    });

    const data = await sendRes.json();
    if (!sendRes.ok) throw new Error(data.message || "Resend error");

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[feedback] Error sending email:", err.message);
    res.status(500).json({ error: "Failed to send. Please try again." });
  }
}
