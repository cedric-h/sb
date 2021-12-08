import { CustomError } from "ts-custom-error";
import { nanoid } from 'nanoid';
import express from 'express';
import { App, ExpressReceiver } from '@slack/bolt';
import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { BadInput, serialize, deserialize, normUserId, stripId } from "./utils";
import fs from "fs";

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

export type Account = {
  cents: number;
  contacts: Map<string, Contact>;
  /* shipId <-> users reacted to it */
  ships: Map<string, Set<string>>;
  figurines: Figurine[];
};
export const blankAccount: () => Account = () => ({
  cents: 0,
  contacts: new Map(),
  ships: new Map(),
  figurines: []
});
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

  const { ok } = await app.client.users.info({ user });
  if (!ok) throw new BadInput(`There is no such user, ${user}`);
  act = blankAccount();
  bank.set(user, act);
  return act;
}

export const goblinstompCmd = async (respond: RespondFn, user: string) => {
  bank.delete(user);
  await respond("Your bank account has been deleted.");
};

export const balCmd = async (app: App, respond: RespondFn, user: string, selfCall: boolean) => {
  const account = await getAccount(app, user);

  let txt = `${selfCall ? "You have" : user + " has"} ${ppcents(account.cents)} available.\n`;
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

  txt += "\n*Figurines:*"
  for (const fig of account.figurines)
    txt += `\n - the ${ppfig(fig)} figurine!`;

  await respond(txt);
};

const givefig = async (app: App, senderId: string, receiverId: string, fig: Figurine) => {
  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);

  const i = sender.figurines.findIndex(({id, kind}) => kind == fig.kind && id == fig.id);
  if (i < 0) throw new BadInput(`You don't have a ${ppfig(fig)} figurine!`);

  sender.figurines.splice(i, 1);
  receiver.figurines.push(fig);
  setTimeout(writeBank, 0);
}

export const givefigCmd = async (
  app: App,
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  fig: Figurine
) => {
  await givefig(app, senderId, receiverId, fig);

  await respond(`Transferred your ${ppfig(fig)} figurine to ${senderId}!`);
  await app.client.chat.postMessage({
    channel: stripId(receiverId)!,
    text: `${senderId} sent you a ${ppfig(fig)} figurine!`,
  });
}

const pay = async (app: App, senderId: string, receiverId: string, centsStr: string) => {
  const cents = parseInt(centsStr);

  if (isNaN(cents)) throw new BadInput(`Expected numerical transaction amount, not ${centsStr}`);
  if (cents <= 0) throw new BadInput(`You can only transact positive amounts, not ${centsStr}`);

  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);

  if (sender.cents < cents)
    throw new BadInput(
      `Insufficient funds: need ${ppcents(cents)}, ` +
      `have ${ppcents(sender.cents)}`
    );

  contactSend(sender, receiverId, cents);
  contactReceive(receiver, senderId, cents);
  sender.cents -= cents;
  receiver.cents += cents;

  setTimeout(writeBank, 0);
  return cents;
}

export const payCmd = async (
  app: App,
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  amt: string
) => {
  const cents = await pay(app, senderId, receiverId, amt);

  const sender   = await getAccount(app, senderId);
  const receiver = await getAccount(app, receiverId);
  await respond(
    `Transferred ${ppcents(cents)} from ${senderId} to ${receiverId}` +
    `\n${senderId} balance: ${(sender.cents + cents)/100} -> ${sender.cents/100}` +
    `\n${receiverId} balance: ${(receiver.cents - cents)/100} -> ${receiver.cents/100}`
  );
};

const tokenAccounts: Map<string, { owner: string, bot: string }> = (() => {
  try {
    return deserialize(fs.readFileSync(tokenfile, "utf-8"));
  } catch(e) {
    console.error("Couldn't read token file: " + e);
    return new Map();
  }
})();
const writeTokenAccounts = () => fs.writeFileSync(tokenfile, serialize(tokenAccounts), 'utf-8');

export const makeApiToken = (input: { owner: string, bot: string }) => {
  const [prevId, { owner: prevOwner }] = [...tokenAccounts.entries()]
    .find(([,x]) => x.bot == input.bot) ?? [, {}];
  if (prevId) tokenAccounts.delete(prevId);

  const id = nanoid();
  tokenAccounts.set(id, input);
  writeTokenAccounts();

  return { id, prevOwner };
}

declare global {
  namespace Express {
    interface Request {
      acc: Account,
      user: string,
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
    console.log(JSON.stringify(req.body, null, 2));
    const token = req.body.apiToken;

    const user = tokenAccounts.get(token)?.bot;
    if (!token || !user)
      throw new NoSuchData("Expected valid `apiToken` query parameter");

    const account = await getAccount(app, user).catch(next)
    if (!account)
      throw new NoSuchData("The account associated with this token no longer exists?");

    req.user = user;
    req.acc = account;
    next();
  }));

  router.post("/api/pay", errWrap(async (req, res, next) => {
    if (!req.body.receiverId) throw new BadInput("Expected `receiverId` field");
    if (!req.body.cents)      throw new BadInput("Expected `cents` field");

    const receiver = normUserId(req.body.receiverId);
    await pay(app, req.user, receiver, req.body.cents).catch(next);

    res.send({ ok: true, newBalance: req.acc.cents });
  }));

  router.post("/api/givefig", errWrap(async (req, res, next) => {
    if (!req.body.receiverId) throw new BadInput("Expected `receiverId` field");
    if (!req.body.fig)        throw new BadInput("Expected `fig` field");
    if (!req.body.fig.kind)   throw new BadInput("Expected `fig.kind` field");
    if (!req.body.fig.id)     throw new BadInput("Expected `fig.id` field");
    if (!["hacker", "emoji"].includes(req.body.fig.kind))
      throw new BadInput("Expected `fig.kind` field to be one of: `hacker`, `emoji`");

    const receiver = normUserId(req.body.receiverId);
    await givefig(app, req.user, receiver, req.body.fig).catch(next);

    res.send({ ok: true, newFigsLen: req.acc.figurines.length });
  }));

};

