import * as Bluebird from 'bluebird';
import * as CryptoJS from 'crypto-js';
import { Key } from './keyUtils';
import * as ks from './keystore';
import * as msg from './msg';
import * as promptly from 'promptly';
import * as wallet from './wallet';
import {
  queryAccount,
  queryLatestBlock,
  queryOracleParams,
  estimateTax,
  broadcast,
  getPrices,
} from './client';

interface VoteArgs {
  ledgerMode: boolean;
  lcdAddress: string;
  chainID: string;
  validator: [string];
  source: [string];
  password: string;
  denoms: string;
  keyPath: string;
}

// yarn start vote command
export async function vote(args: VoteArgs): Promise<void> {
  const { lcdAddress, denoms } = args;
  const { ledgerApp, voter } = await initKey(args.ledgerMode, args.keyPath, args.password);

  const valAddrs = args.validator || [voter.terraValAddress];
  const voterAddr = voter.terraAddress;
  const denomArray = denoms.split(',').map((s) => s.toLowerCase());
  const prevotePrices = {};
  const prevoteSalts = {};
  let lastSuccessVotePeriod = 0;

  while (true) {
    const startTime = Date.now();

    try {
      const {
        oracleVotePeriod,
        oracleWhitelist,
        currentVotePeriod,
        indexInVotePeriod,
      } = await loadOracleParams({
        lcdAddress,
      });

      // Skip until new voting period
      // Skip left block is equal with or less than a block in VotePeriod
      if (
        (lastSuccessVotePeriod && lastSuccessVotePeriod === currentVotePeriod) ||
        indexInVotePeriod >= oracleVotePeriod - 1
      ) {
        throw 'skip';
      }

      const prices = await getPrices(args.source);

      const account = await queryAccount(lcdAddress, voter.terraAddress).catch((err) => {
        console.error(err.message);
        throw 'skip';
      });

      console.info(`voter account: ${JSON.stringify(account)}`);

      // Make not intended denoms prices to zero (abstain)
      // Remove denoms not in
      filterPrices({
        oracleWhitelist,
        denomArray,
        prices,
      });

      // Fill '0' price for not fetched currencies (abstain)
      fillAbstainPrices({
        oracleWhitelist,
        prices,
      });

      // Build Exchage Rate Vote Msgs
      const voteMsgs: object[] = [];
      if (lastSuccessVotePeriod && currentVotePeriod - lastSuccessVotePeriod === 1) {
        voteMsgs.push(
          ...buildVoteMsgs({
            prices,
            valAddrs,
            voterAddr,
            prevotePrices,
            prevoteSalts,
          })
        );
      }

      // Build Exchage Rate Prevote Msgs
      const { prevoteMsgs, priceUpdateMap, priceUpdateSaltMap } = buildPrevoteMsgs({
        prices,
        valAddrs,
        voterAddr,
      });

      const msgs = [...voteMsgs, ...prevoteMsgs];

      if (msgs.length) {
        // Broadcast msgs
        const height = await broadcastMsgs({
          chainID: args.chainID,
          lcdAddress,
          ledgerApp,
          msgs,
          accountNubmer: account.account_number.toString(),
          sequence: account.sequence.toString(),
          voter,
        }).catch((err) => {
          console.log(err.message);
          return -1;
        });

        if (height > 0) {
          // Replace prevote Prices & Salts
          Object.assign(prevotePrices, priceUpdateMap);
          Object.assign(prevoteSalts, priceUpdateSaltMap);

          // Update last success VotePeriod
          lastSuccessVotePeriod = Math.floor(height / oracleVotePeriod);
        }
      }
    } catch (e) {
      if (e !== 'skip') {
        console.error('Error in loop:', e.toString(), 'restart immediately');
        continue;
      }
    }

    // Sleep 5s at least
    await Bluebird.delay(Math.max(5000, 6000 - (Date.now() - startTime)));
  }
}

interface LoadOracleParamsArgs {
  lcdAddress: string;
}

async function loadOracleParams({
  lcdAddress,
}: LoadOracleParamsArgs): Promise<{
  oracleVotePeriod: number;
  oracleWhitelist: [string];
  currentVotePeriod: number;
  indexInVotePeriod: number;
}> {
  const oracleParams = await queryOracleParams({ lcdAddress }).catch((err) => {
    console.error(err.message);
    throw 'skip';
  });

  const oracleVotePeriod = parseInt(oracleParams.vote_period, 10);
  const oracleWhitelist: [string] = oracleParams.whitelist.map(e => e.name);

  const latestBlock = await queryLatestBlock({ lcdAddress }).catch((err) => {
    console.error(err.message);
    throw 'skip';
  });

  const currentBlockHeight = parseInt(latestBlock.block.header.height, 10);
  const currentVotePeriod = Math.floor(currentBlockHeight / oracleVotePeriod);
  const indexInVotePeriod = currentBlockHeight % oracleVotePeriod;

  return { oracleVotePeriod, oracleWhitelist, currentVotePeriod, indexInVotePeriod };
}

async function initKey(
  ledgerMode: boolean,
  keyPath: string,
  password?: string
): Promise<{ ledgerApp?: object; voter: Key }> {
  let ledgerApp;
  let voter;

  if (ledgerMode) {
    console.info(`Initializing ledger`);
    const ledger = require('./ledger');

    const ledgerNode = await ledger.getLedgerNode();
    ledgerApp = await ledger.getLedgerApp(ledgerNode);
    voter = await ledger.getAccountFromLedger(ledgerApp);

    if (voter === null) {
      console.error(`Ledger is not connected or locked`);

      if (ledgerNode !== null) {
        ledgerNode.close_async();
      }
    }

    process.on('SIGINT', () => {
      if (ledgerNode !== null) {
        ledgerNode.close_async();
      }

      process.exit();
    });
  }

  if (!voter) {
    console.info(`getting key from keystore`);

    voter = ks.getKey(
      keyPath,
      password || (await promptly.password(`Enter a passphrase:`, { replace: `*` }))
    );
  }

  return { ledgerApp, voter };
}

interface FilterPricesArgs {
  oracleWhitelist: [string];
  denomArray: [string] | string[];
  prices: {
    currency: string;
    price: string;
  }[];
}

function filterPrices({ oracleWhitelist, denomArray, prices }: FilterPricesArgs) {
  prices.forEach(({ currency }, index, obj) => {
    if (oracleWhitelist.indexOf(`u${currency.toLowerCase()}`) === -1) {
      obj.splice(index, 1);
    }

    if (denomArray.indexOf(currency.toLowerCase()) === -1) {
      obj[index] = { currency, price: '-1.000000000000000000' };
    }
  });
}

interface FillAbstainPricesArgs {
  oracleWhitelist: [string];
  prices: {
    currency: string;
    price: string;
  }[];
}

function fillAbstainPrices({ oracleWhitelist, prices }: FillAbstainPricesArgs) {
  oracleWhitelist.forEach((denom) => {
    let found = false;

    prices.every(({ currency }) => {
      if (denom === `u${currency.toLowerCase()}`) {
        found = true;
        return false;
      }

      return true;
    });

    if (!found) {
      prices.push({ currency: denom.slice(1).toUpperCase(), price: '-1.000000000000000000' });
    }
  });
}

interface BuildVoteMsgsArgs {
  prices: {
    currency: string;
    price: string;
  }[];
  valAddrs: [string];
  voterAddr: string;
  prevotePrices: {};
  prevoteSalts: {};
}

function buildVoteMsgs({
  prices,
  valAddrs,
  voterAddr,
  prevotePrices,
  prevoteSalts,
}: BuildVoteMsgsArgs): object[] {
  const voteMsgs: object[] = [];

  prices.forEach(({ currency }) => {
    const denom = `u${currency.toLowerCase()}`;

    console.info(`vote! ${denom} ${prevotePrices[currency].toString()} ${valAddrs}`);

    valAddrs.forEach((valAddr) => {
      voteMsgs.push(
        msg.generateVoteMsg(
          prevotePrices[currency],
          prevoteSalts[currency],
          denom,
          voterAddr,
          valAddr
        )
      );
    });
  });

  return voteMsgs;
}

interface BuildPrevoteMsgsArgs {
  prices: {
    currency: string;
    price: string;
  }[];
  valAddrs: [string];
  voterAddr: string;
}

function buildPrevoteMsgs({
  prices,
  valAddrs,
  voterAddr,
}: BuildPrevoteMsgsArgs): {
  prevoteMsgs: any[];
  priceUpdateSaltMap: {};
  priceUpdateMap: {};
} {
  const prevoteMsgs: any[] = [];
  const priceUpdateMap = {};
  const priceUpdateSaltMap = {};

  prices.forEach(({ currency, price }) => {
    priceUpdateSaltMap[currency] = CryptoJS.SHA256((Math.random() * 1000).toString())
      .toString()
      .substring(0, 4);

    const denom = `u${currency.toLowerCase()}`;
    console.info(`prevote! ${denom} ${price} ${valAddrs}`);

    valAddrs.forEach((valAddr) => {
      const hash = msg.generateVoteHash(priceUpdateSaltMap[currency], price, denom, valAddr);

      prevoteMsgs.push(msg.generatePrevoteMsg(hash, denom, voterAddr, valAddr));
    });

    priceUpdateMap[currency] = price;
  });

  return { prevoteMsgs, priceUpdateMap, priceUpdateSaltMap };
}

interface BroadcastArgs {
  chainID: string;
  lcdAddress: string;
  msgs: any[];
  accountNubmer: string;
  sequence: string;
  ledgerApp: any;
  voter: any;
}

async function broadcastMsgs({
  chainID,
  lcdAddress,
  ledgerApp,
  msgs,
  accountNubmer,
  sequence,
  voter,
}: BroadcastArgs): Promise<number> {
  const tx = msg.generateStdTx(
    msgs,
    {
      gas: '0',
      amount: [{ denom: 'ukrw', amount: '1' }],
    },
    `Voting from terra feeder`
  );

  tx.fee = await estimateTax(lcdAddress, tx);

  const signature = await wallet.sign(ledgerApp, voter, tx, {
    chain_id: chainID,
    account_number: accountNubmer,
    sequence,
  });

  tx.signatures.push(signature);
  return broadcast(lcdAddress, tx, 'sync');
}
