// 02-11k: proof of control of an address in tests — asks for a code, reads it from the fake Resend log
// (the email sent TO that address) and confirms it. Returns { session, reportGrant }.
export async function verifyEmail(S, email, ip = "10.99.0.1") {
  const before = S.mails().length;
  const r = await S.post("/api/email/verify/start", { email, lang: "es" }, ip);
  if (r.status !== 200) throw new Error(`verify/start ${r.status}`);
  const m = S.mails().slice(before).find((x) => [].concat(x.to).map((a) => String(a).toLowerCase()).includes(String(email).trim().toLowerCase()) && /código/i.test(x.subject));
  if (!m) throw new Error("no code email");
  const code = m.html.match(/letter-spacing:6px">(\d{6})</)[1];
  const c = await S.post("/api/email/verify/confirm", { email, code }, ip);
  if (c.status !== 200) throw new Error(`verify/confirm ${c.status}`);
  return c.json();
}
