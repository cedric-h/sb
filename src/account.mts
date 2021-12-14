import { CustomError } from "ts-custom-error";
import { nanoid } from 'nanoid';
import * as express from 'express';
import fetch from 'node-fetch';
import { App, ExpressReceiver } from '@slack/bolt';
const { App: RuntimeApp } = (await import('@slack/bolt') as any).default as typeof import("@slack/bolt");
import { WebClient } from "@slack/web-api";
import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { BadInput, serialize, deserialize, normUserId, stripId,
         sum, xpData, progBar } from "./utils.mjs";
import * as fs from "fs";

const bankfile = "../bankfile.json";
const tokenfile = "../tokenfile.json";

/* pretty print a cents value as dollars, in bold with an emoji after */
export const ppcents = (cents: number) => `*${(cents/100).toFixed(2)}:sc:*`;
export const ppfig = ({kind, id}: Figurine) => (kind == FigKind.Hacker) ? `<@${id}>` : `:${id}:`;


/* I could probably make Contact and Account actual `class`es,
 * but I'd have to hack something together for their [de]serialization,
 * probably registering their prototypes with utils.js or whatever;
 * it wouldn't be hard but it would slow me down more than this */


export type Contact = {
  centsSentTo: number;
  centsReceivedFrom: number;
  transactionsSentTo: number;
  transactionsReceivedFrom: number;
};
export const blankContact: () => Contact = () => ({
  centsSentTo: 0,
  centsReceivedFrom: 0,
  transactionsSentTo: 0,
  transactionsReceivedFrom: 0,
});

export enum FigKind {
  Emoji = "emoji",
  Hacker = "hacker",
}
export type Figurine = {
  kind: FigKind,
  /* emoji names aren't wrapped in :x: and the pings aren't wrapped in <@x> */
  id: string,
}

type Hook = { centsOrFig: number | Figurine, hooked: string, hooker: string, desc: string };
export type Account = {
  xp: number;
  heat: number;
  lastXp: number;
  cents: number;
  hooks: Map<string, Hook>;
  contacts: Map<string, Contact>;
  /* shipId <-> users reacted to it */
  ships: Map<string, Set<string>>;
  figurines: Figurine[];
  botToken?: string;
};
export const blankAccount: () => Account = () => ({
  xp: 0,
  heat: 0,
  lastXp: Date.now(),
  cents: 0,
  hooks: new Map(),
  contacts: new Map(),
  ships: new Map(),
  figurines: [],
});
const addAccountXp = (account: Account, xp: number) => {
  /* heat cools off at one cent per second */
  account.heat -= Math.floor((Date.now() - account.lastXp) / 1000);
  account.lastXp = Date.now();
  account.heat += xp;

  const boost = xp * Math.max(0.1, 1.0 - (xp / (xpData(xp).levelNeedsTotal / 100)));
  account.xp = Math.floor(account.xp + boost)
}
const contactSend = (account: Account, toId: string, cents: number) => {
  const contact = account.contacts.get(toId) ?? blankContact();
  contact.transactionsSentTo++;
  contact.centsSentTo += cents;
  account.contacts.set(toId, contact);
};
const contactReceive = (account: Account, fromId: string, cents: number) => {
  const contact = account.contacts.get(fromId) ?? blankContact();
  contact.transactionsReceivedFrom++;
  contact.centsReceivedFrom += cents;
  account.contacts.set(fromId, contact);
};

const bank: Map<string, Account> = (() => {
  try {
    return deserialize(fs.readFileSync(bankfile, "utf-8"));
  } catch(e) {
    console.error("Couldn't read balance file: " + e);
    return new Map();
  }
})();

/* exported for use by passgo */
export const writeBank = () => fs.writeFileSync(bankfile, serialize(bank), "utf-8");

/* exported for use by passgo */
export const getAccount = async (app: App, user: string) => {
  let act = bank.get(user);
  if (act) return act;

  const { ok } = await app.client.users.info({ user: stripId(user)! });
  if (!ok) throw new BadInput(`There is no such user, ${user}`);
  
  act = blankAccount();
  bank.set(user, act);
  return act;
}

/* useful for testing, can't expose to users even for their own account
 * because they could delete and repassgo until they get the figs they want */
export const goblinstompCmd = async (respond: RespondFn, user: string) => {
  bank.delete(user);
  await respond("Your bank account has been deleted.");
};

export const balCmd = async (app: App, respond: RespondFn, user: string, selfCall: boolean) => {
  const account = await getAccount(app, user);

  const { prog, goal, levelName, index } = xpData(account.xp);
  let txt = `${progBar(50, prog/goal)}\n*${levelName}* (_Level ${index}_): ${prog}/${goal}xp\n\n`;

  txt += `${selfCall ? "You have" : user + " has"} ${ppcents(account.cents)} available.\n`;
  if (account.contacts.size > 3) {
    txt += "\n";
    const contacts = [...account.contacts.entries()];

    /* using Object.entries here rather than a matrix literal just
     * for syntax highlighting */
    const tracked = Object.entries({
      centsSentTo:              "sent a total of AMT to",
      centsReceivedFrom:        "received a total of AMT from",
      transactionsSentTo:       "received *AMT* separate transactions from",
      transactionsReceivedFrom: "sent *AMT* separate transactions to",
    }) as [keyof Contact, string][];

    const [key, desc] = tracked[Math.floor(Math.random() * tracked.length)];

    /* grab an outlier in this field of contact */
    contacts.sort((a, b) => a[1][key] - b[1][key]);
    const topNth = Math.floor(Math.random() * 3);
    const [olId, outlier] = contacts[Math.min(topNth, contacts.length - 1)];

    let val: string | number = outlier[key];
    if (key.includes("cents"))
      val = ppcents(val); /* have to show the user dollars */

    txt += selfCall ? "You have" : (user + "has");
    txt += " " + desc.replace("AMT", "" + val) + " " + olId;
    txt += '\n';
  }

  if (account.figurines.length)
    txt += "\n*Figurines:*"
  for (const fig of account.figurines)
    txt += `\n - the ${ppfig(fig)} figurine!`;

  const plainText = (text: string) => ({ "type": "plain_text", text });
  const mrkdwn = (text: string) => ({ "type": "mrkdwn", text });
  const textion = (text: string) => ({ "type": "section", "text": mrkdwn(text) });
  const blocks = [textion(txt)];
  if (account.hooks.size)
    blocks.push(textion("\n*Hooks:*"));
  for (const [hookId, { desc, hooker, centsOrFig }] of account.hooks) {
    const name = typeof centsOrFig == "number" ? ppcents(centsOrFig) : ppfig(centsOrFig);
    blocks.push(Object.assign(textion(`${name} to ${hooker} for ${desc}`), { "accessory": {
      "type": "button",
      "text": plainText("Revoke"),
      "confirm": {
        "title": plainText("Are you sure?"),
        "text": mrkdwn(
          `Revoking this hook will get you your ${name} back` + 
            `, but it will no longer be held by ${hooker} for ${desc.split('*').join('')}`
        ),
        "confirm": plainText("Revoke Hook"),
        "deny": plainText("Keep Hook"),
        "style": "danger",
      },
      "style": "danger",
      "action_id": "revoke_hook",
      "value": hookId,
    }}));
  }

  await respond({ text: txt, blocks });
};

export const revokeHook = async ({ client, ack, action, body }: any) => {
  await ack();

  /* this is so cursed but I don't have time to make the functions only take clients */
  const app = { client } as App;

  /* pull what we need out of the args */
  const [revoker, hookId] = [normUserId(body.user.id), action.value];

  const revokerHooks = (await getAccount(app, revoker)).hooks;
  const hook = revokerHooks.get(hookId)!;
  const { centsOrFig, hooker } = hook;
  const bot = botTokens.get((await getAccount(app, hooker)).botToken!)!;

  revokerHooks.delete(hookId);
  bot.hooks.delete(hookId);

  if (typeof centsOrFig == "number")
    await pay(app, hooker, revoker, "" + centsOrFig, "hook revoked");
  else
    await givefig(app, hooker, revoker, centsOrFig, "hook revoked");

  await sendBot(app, bot, { "kind": "revokedHook", hook, hookId });

  setTimeout(writeBank, 0);
  setTimeout(writeBotTokens, 0);
}

const givefig = async (
  app: App,
  senderId: string,
  receiverId: string,
  fig: Figurine,
  whatFor?: string
) => {
  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);

  const figcmp = (a: Figurine, b: Figurine) => a.kind == b.kind && a.id == b.id;
  const availableFigs: Figurine[] = [...sender.figurines];

  const hooks = [...sender.hooks.values()];
  if (sender.botToken) hooks.push(...botTokens.get(sender.botToken)!.hooks.values());
  for (const { centsOrFig } of hooks)
    if (typeof centsOrFig != "number") {
      const i = availableFigs.findIndex(x => figcmp(x, centsOrFig));
      if (i > -1) availableFigs.splice(i, 1);
    }

  if (!availableFigs.some(x => figcmp(x, fig)))
    throw new BadInput(`You don't have a ${ppfig(fig)} figurine!`)

  sender.figurines.splice(sender.figurines.findIndex(x => figcmp(x, fig)), 1);
  receiver.figurines.push(fig);

  /* I don't think there's any point in notifying the sender that they paid ... */
  if (receiver.botToken)
    sendBot(app, botTokens.get(receiver.botToken)!, {
      "kind": "receivedFig",
      "for": whatFor,
      "from": senderId,
      "fig": Object.assign({ fmted: ppfig(fig) }, fig),
    });

  let text = `${senderId} sent you a ${ppfig(fig)} figurine`;
  if (whatFor) text += ' for ' + whatFor;
  text += "!";
  app.client.chat.postMessage({ channel: stripId(receiverId)!, text });

  setTimeout(writeBank, 0);
}

export const givefigCmd = async (
  app: App,
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  fig: Figurine,
  whatFor?: string,
) => {
  await givefig(app, senderId, receiverId, fig, whatFor);

  await respond(`Transferred your ${ppfig(fig)} figurine to ${receiverId}!`);
}

const pay = async (
  app: App,
  senderId: string,
  receiverId: string,
  centsStr: string,
  whatFor?: string
) => {
  const cents = parseInt(centsStr);

  if (isNaN(cents)) throw new BadInput(`Expected numerical transaction amount, not ${centsStr}`);
  if (cents <= 0) throw new BadInput(`You can only transact positive amounts, not ${centsStr}`);

  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);

  let senderUsableCents = sender.cents;

  /* subtract hooks from usable cents */
  const hooks = [...sender.hooks.values()];
  if (sender.botToken) /* bots can have outgoing hooks too */
    hooks.push(...botTokens.get(sender.botToken)!.hooks.values());
  senderUsableCents -= sum(hooks.reduce((a, x) => typeof x == "number" ? [x, ...a] : a, []));

  if (senderUsableCents < cents)
    throw new BadInput(
      `Insufficient funds: need ${ppcents(cents)}` +
      `, have available ${ppcents(senderUsableCents)}` +
      ((senderUsableCents != sender.cents)
        ? ` (before hooks, it'd be ${ppcents(sender.cents)}, so maybe revoke some)`
        : '')
    );

  for (const [account, otherId] of [[sender, receiverId], [receiver, senderId]] as const) {
    if (!account.contacts.has(otherId))
      addAccountXp(account, 1000);
    addAccountXp(account, 100 + Math.min(100, cents/1000));
  }

  contactSend(sender, receiverId, cents);
  contactReceive(receiver, senderId, cents);
  sender.cents -= cents;
  receiver.cents += cents;

  /* I don't think there's any point in notifying the sender that they paid ... */
  if (receiver.botToken)
    sendBot(app, botTokens.get(receiver.botToken)!, {
      "kind": "receivedCents",
      "for": whatFor,
      "from": senderId,
      cents,
    });

  let text = `${senderId} sent you ${ppcents(cents)}`;
  if (whatFor) text += ' for ' + whatFor;
  text += '!';
  app.client.chat.postMessage({ channel: stripId(receiverId)!, text });

  setTimeout(writeBank, 0);
  return cents;
}

export const payCmd = async (
  app: App,
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  amt: string,
  whatFor?: string
) => {
  const cents = await pay(app, senderId, receiverId, amt, whatFor);

  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);
  await respond(
    `Transferred ${ppcents(cents)} from ${senderId} to ${receiverId}` +
    `\n${senderId} balance: ${(sender.cents + cents)/100} -> ${sender.cents/100}` +
    `\n${receiverId} balance: ${(receiver.cents - cents)/100} -> ${receiver.cents/100}`
  );
};

type Bot = {
  ownerId: string;
  botId: string;
  endpointUrl: string;
  hooks: Map<string, Hook>;
}
const botTokens: Map<string, Bot> = (() => {
  try {
    return deserialize(fs.readFileSync(tokenfile, "utf-8"));
  } catch(e) {
    console.error("Couldn't read token file: " + e);
    return new Map();
  }
})();
const writeBotTokens = () => fs.writeFileSync(tokenfile, serialize(botTokens), 'utf-8');
const sendBot = async (app: App, bot: Bot, json: { kind: string, [k: string]: any }) => {
  await fetch(bot.endpointUrl, {
    method: 'post',
    body: serialize(json),
    headers: { "Content-Type": "application/json" }
  }).catch(async e => {
    await app.client.chat.postMessage({
      channel: stripId(bot.ownerId)!,
      text: `uhh, just tried to send your bot ${bot.botId} a ${json.kind} event` +
        ` but this happened: ${e}`,
    });
  });
};

export const makeApiToken = async (app: App, bot: Omit<Bot, "hooks">) => {
  const [prevId, { ownerId: prevOwner }] = [...botTokens.entries()]
    .find(([,x]) => x.botId == bot.botId) ?? [, {}];
  if (prevId) botTokens.delete(prevId);

  const token = nanoid();
  botTokens.set(token, Object.assign({ hooks: new Map() }, bot));
  writeBotTokens();

  (await getAccount(app, bot.botId)).botToken = token;
  setTimeout(writeBank, 0);

  return { token, prevOwner };
}

declare global {
  namespace Express {
    interface Request {
      acc: Account,
      user: string,
      bot: Bot,
    }
  }
}
export const api = (app: App, { router }: ExpressReceiver) => {
  class NoSuchData extends CustomError {}

  type exRequest = express.Request;
  type exResponse = express.Response;

  /* unfortunately until Slack starts exposing a Express 5 Router, this lets us provide
   * a nicer API (esp. wrt. just throwing errors and knowing it'll catch them) than built-in
   * express error handlers */
  const errWrap = (fn: (req: exRequest, res: exResponse, next: any) => Promise<void>) => {
    return async (...args: [exRequest, exResponse, any]) => {
      return await fn(...args).catch(err => {
        const res = args[1];

        console.error(err);
        if (err instanceof BadInput)
          res.status(400);
        else if (err instanceof NoSuchData)
          res.status(404);
        else
          res.status(500);
        res.send({ ok: false, error: err.message });
      });
    }
  };

  router.use(express.json());

  router.use("/api", errWrap(async (req, res, next) => {
    console.log(req.path, req.body);
    const token = req.body.apiToken;

    const bot = botTokens.get(token);
    if (!token || !bot)
      throw new NoSuchData("Expected valid `apiToken` query parameter");

    const account = await getAccount(app, bot.botId);
    if (!account)
      throw new NoSuchData("The account associated with this token no longer exists?");

    req.bot = bot;
    req.user = bot.botId;
    req.acc = account;
    next();
  }));

  router.post("/api/pullhook", errWrap(async ({ body, bot }, res) => {
    if (!body.hookId) throw new BadInput("Expected `hookId` field");
    const hook = bot.hooks.get(body.hookId);
    if (!hook) throw new BadInput("No hook with hookid");
    bot.hooks.delete(body.hookId);
    (await getAccount(app, hook.hooked)).hooks.delete(body.hookId);
    setTimeout(writeBank, 0);
    setTimeout(writeBotTokens, 0);
    res.send({ ok: true });
  }));

  const addHook = async (req: exRequest, res: exResponse) => {
      const { hook: { desc } } = req.body;
      if (!desc) throw new BadInput("Please provide a `desc` field on your hooks");
      const hookId = nanoid();
      const hook = {
        centsOrFig: req.body.cents ?? req.body.fig,
        hooker: req.user,
        hooked: normUserId(req.body.receiverId),
        desc,
      };
      req.bot.hooks.set(hookId, hook);
      (await getAccount(app, req.body.receiverId)).hooks.set(hookId, hook);
      setTimeout(writeBank, 0);
      setTimeout(writeBotTokens, 0);
      res.send({ ok: true, hookId });
  }

  router.post("/api/pay", errWrap(async (req, res, next) => {
    if (!req.body.receiverId) throw new BadInput("Expected `receiverId` field");
    if (!req.body.cents)      throw new BadInput("Expected `cents` field");

    if (req.body.hook) return await addHook(req, res);

    const receiver = normUserId(req.body.receiverId);
    await pay(app, req.user, receiver, req.body.cents, req.body["for"]);

    res.send({ ok: true, newBalance: req.acc.cents });
  }));

  router.post("/api/givefig", errWrap(async (req, res, next) => {
    if (!req.body.receiverId) throw new BadInput("Expected `receiverId` field");
    if (!req.body.fig)        throw new BadInput("Expected `fig` field");
    if (!req.body.fig.kind)   throw new BadInput("Expected `fig.kind` field");
    if (!req.body.fig.id)     throw new BadInput("Expected `fig.id` field");
    if (!["hacker", "emoji"].includes(req.body.fig.kind))
      throw new BadInput("Expected `fig.kind` field to be one of: `hacker`, `emoji`");

    if (req.body.hook) return await addHook(req, res);

    const receiver = normUserId(req.body.receiverId);
    await givefig(app, req.user, receiver, req.body.fig);

    res.send({ ok: true, newFigsLen: req.acc.figurines.length });
  }));

};

