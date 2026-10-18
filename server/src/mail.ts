// Reads the key-mail account's in-game mail through the Adventure Land web API (the same endpoints
// ALClient uses) and registers reporting keys from "alninja_auth" mail.
import { config } from "./config.ts";
import { KEY_SUBJECT, keyProblem, setKey } from "./keys.ts";

interface Mail {
  id: string;
  fro: string;
  to: string;
  sent: string;
  subject: string;
  message: string;
  item?: string;
}

type Fetch = typeof fetch;

interface ApiOptions {
  url: string;
  email: string | null;
  password: string | null;
  auth: string | null;
}

export class AdventureLandApi {
  private auth: string | null;
  private readonly opts: ApiOptions;
  private readonly fetchImpl: Fetch;

  constructor(opts: ApiOptions, fetchImpl: Fetch = fetch) {
    this.opts = opts;
    this.fetchImpl = fetchImpl;
    this.auth = opts.auth;
  }

  private async login() {
    if (!this.opts.email || !this.opts.password) throw new Error("not logged in, and no AL_EMAIL / AL_PASSWORD to log in with");
    const res = await this.fetchImpl(`${this.opts.url}/api/signup_or_login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.opts.email, password: this.opts.password, only_login: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as { success?: boolean; user?: string; auth?: string; reason?: string };
    if (!data.success || !data.user || !data.auth) throw new Error(`login failed: ${data.reason ?? res.status}`);
    this.auth = `${data.user}-${data.auth}`;
  }

  /** POSTs an API method; logs in first if needed, and once more if the session has expired. */
  private async call<T>(method: string, body: object, retry = true): Promise<T> {
    if (!this.auth) await this.login();
    const res = await this.fetchImpl(`${this.opts.url}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `auth=${this.auth}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as { infs?: T[] } | null;
    if (!res.ok || !data?.infs?.[0]) {
      if (retry && this.opts.email) {
        this.auth = null;
        return this.call(method, body, false);
      }
      throw new Error(this.opts.email
        ? `${method} failed (${res.status})`
        : `${method} failed (${res.status}): AL_AUTH was rejected; copy a fresh session token ` +
          '(in game: show_json(parent.user_id + "-" + parent.user_auth)) into AL_AUTH');
    }
    return data.infs[0];
  }

  async pullMail(): Promise<Mail[]> {
    const mail: Mail[] = [];
    let page = await this.call<{ mail: Mail[]; more: boolean; cursor: string }>("pull_mail", {});
    for (let pages = 0; page.mail.length && pages < 20; pages++) {
      mail.push(...page.mail);
      if (!page.more) break;
      page = await this.call("pull_mail", { cursor: page.cursor });
    }
    return mail;
  }

  async deleteMail(id: string): Promise<boolean> {
    const r = await this.call<{ message: string }>("delete_mail", { mid: id });
    return r.message === "Mail deleted.";
  }
}

/**
 * Registers keys from "alninja_auth" mail to KEY_MAIL_CHARACTER (oldest first, so a newer mail wins)
 * and deletes those mails. Other mail on the account is never touched, nor is any mail with an item.
 */
export async function processKeyMail(api: AdventureLandApi, mailTo: string, log = console.log) {
  const mail = (await api.pullMail()).reverse();
  let registered = 0;
  for (const m of mail) {
    if (m.subject.trim().toLowerCase() !== KEY_SUBJECT) continue;
    if (m.to.toLowerCase() !== mailTo.toLowerCase()) continue;
    if (m.item) {
      log(`[keys] ${m.fro} attached an item to their key mail; leaving it for the account owner`);
      continue;
    }
    const key = m.message.trim();
    const problem = keyProblem(key);
    if (problem) log(`[keys] ignored key from ${m.fro}: needs ${problem}`);
    else {
      setKey(m.fro, key, Date.parse(m.sent) || Date.now());
      registered++;
      log(`[keys] registered reporting key for ${m.fro}`);
    }
    await api.deleteMail(m.id);
  }
  return registered;
}

/** Checks key mail every minute when KEY_MAIL_CHARACTER and account credentials are configured. */
export function startKeyMailLoop() {
  if (!config.keyMailCharacter) return;
  if (!config.alAuth && !(config.alEmail && config.alPassword)) {
    console.warn("[keys] KEY_MAIL_CHARACTER is set but AL_AUTH or AL_EMAIL/AL_PASSWORD is missing; key mail is off");
    return;
  }
  const api = new AdventureLandApi({
    url: config.alUrl, email: config.alEmail, password: config.alPassword, auth: config.alAuth,
  });
  console.log(`[keys] checking mail to ${config.keyMailCharacter} for "${KEY_SUBJECT}" every minute`);
  const loop = async () => {
    try {
      await processKeyMail(api, config.keyMailCharacter!);
    } catch (err) {
      console.error(`[keys] mail check failed: ${(err as Error).message}`);
    } finally {
      setTimeout(loop, 60_000).unref();
    }
  };
  loop();
}
