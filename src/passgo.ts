import { App } from '@slack/bolt';
import { Reaction } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { Figurine, FigKind, writeBank, ppcents, getAccount, Account } from "./account";
import * as ships from "./ships";
import { normUserId, sum } from "./utils";

/* this file's dependency on account.ts and manifest.ts is ... primarily
 * a historical artifact, probably. if it turns out harmful, it can easily
 * be remedied in a subsequent reorganization. not sure why it would though?
 *
 * it updates what your account has recorded about your ships with what
 * slack is saying, printing out an update describing what that entailed. */

const figurineChance = (account: Account, acc: number, emoji: string, users: string[]) => {
  const figs = [];

  /* you're x5 more likely to get a figurine if you haven't earned over 100sc */
  const baseChance = 0.018;
  const chance = (acc < 100) ? baseChance : (baseChance/5);

  if (Math.random() < chance)
    figs.push({ kind: FigKind.Emoji, id: emoji });
  if (Math.random() < chance) {
    const randomHackerId = users[Math.floor(Math.random() * users.length)];
    figs.push({ kind: FigKind.Hacker, id: randomHackerId });
  }

  account.figurines.push(...figs);
  return figs;
}

export default async (app: App, respond: RespondFn, user: string) => {
  const account = await getAccount(app, user);
  const moji = (await ships.moji(app)).get(user) ?? [];
  /* slack uses timestamps as ids */
  moji.sort((a, b) => parseFloat(a.msg) - parseFloat(b.msg));

  if (moji.length == 0)
    return await respond(ships.neverShipped404(true));

  let txt = "";

  /* so acc starts with what you've earned from passgo previously, and as your messages
   * are iterated through, acc approaches sum(moji.map(x => x.count)). (may exceed it
   * because of fig bonuses) */
  const startCents = sum([...account.ships.values()].map(x => x.size)) * 100;
  let acc = startCents;

  const overviewFigs: Figurine[] = [];


  const accAdd = (dollars: number, shipMsg: string, emoji: string, users: string[]) => {
    /* every sc earned is another chance at earning a fig */
    for (let i = 0; i < dollars; i++) {
      const figs = figurineChance(account, acc, emoji, users);
      if (figs.length > 0) {
        for (const { kind, id } of figs) {
          const idrep = kind == FigKind.Hacker ? normUserId(id) : (":"+id+":");
          const kindrep = kind == FigKind.Hacker ? "" : "emoji "
          txt += "\n*OMG YOU EARNED A FIGURINE!!!*" +
            ` It's the ${idrep} ${kindrep}one!`;
        }
        overviewFigs.push(...figs);
      }
    }

    const usersOnRecord = account.ships.get(shipMsg) ?? new Set();
    /* and figs increase the sc you earn (where applicable) */
    for (const { kind, id } of account.figurines) {
      /* so when someone reacts to a ship and the owner of that ship has a figurine of them,
       * we need to award the ship's owner +5sc. We know that this is the first time that
       * user reacted to that ship because we never overwrite account.ships.get(*).user, it
       * only ever grows.
       * 
       * NOTE: theoretically, calling accAdd multiple times before updating account.ships could
       *       overaward users. */
      if (kind == FigKind.Hacker && users.includes(id) && !usersOnRecord.has(id))
        acc += 500;

      if (kind == FigKind.Emoji && emoji == id) {
        const min = 35, max = 45;
        acc += Math.round(min + (max - min) * Math.random());
      }
    }

    acc += dollars * 100;
  };

  if (moji.every(x => x.count == account.ships.get(x.msg)))
    return await respond(
      "*No recent changes on your ships!*" +
      " They're still worth " + ppcents(startCents) + ".\n" +
      "Try /sc manifest to get some interesting data about your ships overall."
    );

  for (const {count, users, name, msg} of moji) {
    const onRecord = account.ships.get(msg)?.size;
    if (onRecord) {
      /* nothing to alert you to if the ship & reacts haven't changed */
      if (onRecord == count) continue;

      accAdd(count! - onRecord, msg, name!, users!);
      txt += "\nFound " + ships.link(msg, "More Reactions") + "!" +
        ` *:${name}: ${onRecord}* ->` + ` *:${name}: ${acc}*!\n`;
    } else {
      const accB4 = acc;
      accAdd(count!, msg, name!, users!);
      txt += "\nFound " + ships.link(msg, "New Ship") + "!" + ` :${name}: ` +
        ppcents(accB4) + " -> " + ppcents(acc);
    }
  }
  account.ships = new Map(moji.map(x => {
    const existing = account.ships.get(x.msg) ?? new Set();
    return [
      x.msg, 
      /* prevents people from getting sc from adding and removing emoji
       * also, same thing as above but with figurines */
      new Set([...x.users!].concat(...existing)),
    ];
  }));
  account.cents += Math.max(0, acc - startCents);

  if (overviewFigs.length > 0) {
    txt += "\n\n*You've earned ";
    txt += (overviewFigs.length > 1)
      ? (overviewFigs.length + " figurines")
      : "a figurine";
    txt += "!* Now, you will get more sc from reacts of the emoji or" +
      " hack clubber the figurine represents. You can also trade or sell" +
      " the figurine to other hackclubbers.";
  }

  txt += "\n\n_Overview: " + ppcents(startCents) + " -> " +
    ppcents(acc) + "_";

  await respond(txt);
  writeBank();
}
