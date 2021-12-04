import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { serialize, deserialize } from "./utils";
import fs from "fs";

const bankfile = "../bankfile.json";

/* pretty print a cents value as dollars, in bold with an emoji after */
const ppcents = (cents: number) => `*${(cents/100).toFixed(2)}:scales:*`;


/* I could probably make Contact and Account actual classes,
 * but I'd have to hack something together for their [de]serialization,
 * probably registering their prototypes with utils.js or whatever;
 * it wouldn't be hard but it would slow me down more than this */


type Contact = {
  centsSentTo: number;
  centsReceivedFrom: number;
  transactionsSentTo: number;
  transactionsReceivedFrom: number;
};
const blankContact: () => Contact = () => ({
  centsSentTo: 0,
  centsReceivedFrom: 0,
  transactionsSentTo: 0,
  transactionsReceivedFrom: 0,
});

type Account = {
  cents: number;
  contacts: Map<string, Contact>;
  /* shipId <-> cents earned from it */
  ships: Map<string, number>;
};
const blankAccount: () => Account = () => ({
  cents: 0,
  contacts: new Map(),
  ships: new Map(),
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
export const getAccount = (user: string) => {
  return bank.set(user, bank.get(user) ?? blankAccount()).get(user)!;
}

export const bal = async (respond: RespondFn, user: string, selfCall: boolean) => {
  const account = getAccount(user);

  let txt = `You have ${ppcents(account.cents)} available.`;
  if (account.contacts.size > 3) {
    txt += "\n";
    const contacts = [...account.contacts.entries()];

    /* using Object.entries here rather than a matrix literal just
     * for syntax highlighting */
    const tracked = Object.entries({
      centsSentTo:              "sent a total of *AMT:scales:* to",
      centsReceivedFrom:        "received a total of *AMT:scales:* from",
      transactionsSentTo:       "received *AMT* separate transactions from",
      transactionsReceivedFrom: "sent *AMT* separate transactions to",
    }) as [keyof Contact, string][];

    const [key, desc] = tracked[Math.floor(Math.random() * tracked.length)];

    /* grab an outlier in this field of contact */
    contacts.sort((a, b) => a[1][key] - b[1][key]);
    const topNth = Math.floor(Math.random() * 3);
    const [olId, outlier] = contacts[Math.min(topNth, contacts.length - 1)];

    let val = outlier[key];
    if (key.includes("cents")) /* have to show the user dollars */
      val /= 100;

    txt += selfCall ? "You have" : (user + "has");
    txt += " " + desc.replace("AMT", "" + val) + " " + olId;
  }
  await respond(txt);
};

export const send = async (
  respond: RespondFn,
  senderId: string,
  receiverId: string,
  cents: number
) => {
  if (cents <= 0) throw new Error("You can only transact positive amounts");

  const sender   = getAccount(senderId);
  const receiver = getAccount(receiverId);

  if (sender.cents < cents)
    throw new Error(`Insufficient funds: need ${ppcents(cents)}, have ${ppcents(sender.cents)}`);

  contactSend(sender, receiverId, cents);
  contactReceive(receiver, senderId, cents);
  sender.cents -= cents;
  receiver.cents += cents;

  await respond(
    `Transferred ${ppcents(cents)} from ${senderId} to ${receiverId}` +
    `\n${senderId} balance: ${(sender.cents + cents)/100} -> ${sender.cents/100}` +
    `\n${receiverId} balance: ${(receiver.cents - cents)/100} -> ${receiver.cents/100}`
  );

  fs.writeFileSync(bankfile, serialize(bank), "utf-8");
};
