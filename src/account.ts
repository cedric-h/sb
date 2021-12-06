import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { BadInput, serialize, deserialize } from "./utils";
import fs from "fs";

const bankfile = "../bankfile.json";

/* pretty print a cents value as dollars, in bold with an emoji after */
export const ppcents = (cents: number) => `*${(cents/100).toFixed(2)}:sc:*`;


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
export const writeBank = () => {
  fs.writeFileSync(bankfile, serialize(bank), "utf-8");
};

/* exported for use by passgo */
export const getAccount = (user: string) => {
  return bank.set(user, bank.get(user) ?? blankAccount()).get(user)!;
}

export const goblinstompCmd = async (respond: RespondFn, user: string) => {
  bank.delete(user);
  await respond("Your bank account has been deleted.");
};

export const balCmd = async (respond: RespondFn, user: string, selfCall: boolean) => {
  const account = getAccount(user);

  let txt = `You have ${ppcents(account.cents)} available.\n`;
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
  for (const { kind, id } of account.figurines) {
    txt += "\n - the ";
    if (kind == FigKind.Hacker)
      txt += `<@${id}>`;
    else
      txt += `:${kind}:`;
    txt += " figurine!"
  }

  await respond(txt);
};

export const sendCmd = async (
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  cents: number
) => {
  if (cents <= 0) throw new BadInput("You can only transact positive amounts");

  const sender   = getAccount(senderId);
  const receiver = getAccount(receiverId);

  if (sender.cents < cents)
    throw new BadInput(
      `Insufficient funds: need ${ppcents(cents)}, ` +
      `have ${ppcents(sender.cents)}`
    );

  contactSend(sender, receiverId, cents);
  contactReceive(receiver, senderId, cents);
  sender.cents -= cents;
  receiver.cents += cents;

  await respond(
    `Transferred ${ppcents(cents)} from ${senderId} to ${receiverId}` +
    `\n${senderId} balance: ${(sender.cents + cents)/100} -> ${sender.cents/100}` +
    `\n${receiverId} balance: ${(receiver.cents - cents)/100} -> ${receiver.cents/100}`
  );

  writeBank();
};
