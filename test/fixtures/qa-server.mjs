// Servidor real con Resend simulado (test/fake-resend.mjs) y búsqueda ficticia (test/fixtures): nada sale.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function server(portBase, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-qa-"));
  const MAIL_LOG = path.join(dir, "mails.jsonl");
  const s = { BASE: "", proc: null, logs: "" };
  const once = (PORT) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", path.resolve("test/fixtures/stub-register.mjs"), "--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
        env: {
          ...process.env,
          PORT: String(PORT),
          DATA_DIR: dir,
          MAIL_LOG,
          RESEND_API_KEY: "re_test",
          LEADS_EMAIL: "ventas@example.test",
          LEADS_CC: "",
          QA_NOTIFY_EMAILS: "qa-dev@example.test",
          QA_EMAILS: "qa1@prueba.test",
          VERIFY_MAX_PER_ADDRESS_HOUR: "100",
          VERIFY_MAX_PER_IP_HOUR: "1000",
          QA_LEADS_EMAIL: "",
          ADMIN_EMAIL: "",
          ADMIN2_EMAIL: "",
          DEV_COPIES_REAL_LEADS: "",
          PUBLIC_API_URL: "",
          GROQ_API_KEY: "",
          EMAIL_DRY_RUN: "",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout.on("data", (d) => {
        s.logs += d;
        if (String(d).includes("running at")) {
          p.removeAllListeners("exit");
          resolve(p);
        }
      });
      p.stderr.on("data", (d) => (s.logs += d));
      p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
  s.start = async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      const PORT = portBase + Math.floor(Math.random() * 180);
      try {
        s.proc = await once(PORT);
        s.BASE = `http://127.0.0.1:${PORT}`;
        await new Promise((r) => setTimeout(r, 200));
        return;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  s.stop = async () => {
    await new Promise((r) => {
      s.proc.removeAllListeners("exit");
      s.proc.on("exit", r);
      s.proc.kill("SIGTERM");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  /** every send attempted (also the ones Resend refused) */
  s.attempts = () => (fs.existsSync(MAIL_LOG + ".attempts") ? fs.readFileSync(MAIL_LOG + ".attempts", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  s.mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  s.post = (p, body, ip) => fetch(s.BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  return s;
}
