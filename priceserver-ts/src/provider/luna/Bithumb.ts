import nodeFetch from 'node-fetch';
import { errorHandler } from 'lib/error';
import { toFormData } from 'lib/fetch';
import * as logger from 'lib/logger';
import { num } from 'lib/num';
import { WebSocketQuoter, Trades } from '../base';

const headers = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest'
};

const requestData = {
  KRW: {
    // LUNA/KRW
    coinType: 'C0534',
    crncCd: 'C0100',
    tickType: '01M',
    csrf_xcoin_name: 'd2e131dccab300919c9fafcec567bb51'
  }
};

interface CandlestickResponse {
  error: string;
  message?: string;
  data?: any;
}

interface TransactionResponse {
  content: {
    list: {
      symbol: string;
      contPrice: string; // price
      contQty: string; // volume
      contDtm: string; // transaction time
    }[];
  };
}

export class Bithumb extends WebSocketQuoter {
  private isUpdated: boolean = false;

  public async initialize(): Promise<void> {
    for (const quote of this.quotes) {
      this.setTrades(quote, []);

      // update last trades and price of LUNA/quote
      await this.fetchLatestTrades(quote)
        .then(trades => {
          if (!trades.length) {
            return;
          }

          this.setTrades(quote, trades);
          this.setPrice(quote, trades[trades.length - 1].price);
        })
        .catch(errorHandler);
    }

    // connect to bithumb websocket server
    this.connect('wss://pubwss.bithumb.com/pub/ws');

    return;
  }

  protected onConnect() {
    super.onConnect();

    // subscribe transaction
    const symbols = this.quotes.map(quote => `"${this.baseCurrency}_${quote}"`).join(',');
    this.ws.send(`{"type":"transaction", "symbols":[${symbols}]}`);
  }

  protected onData(data: any) {
    if (data?.status === '0000') {
      logger.info(`${this.constructor.name}: ${data.resmsg}`);
      return;
    }

    switch (data?.type) {
      case 'transaction':
        this.onTransaction(data);
        break;

      default:
        logger.warn(`${this.constructor.name}: receive unknown type data`, data);
        break;
    }
  }

  private onTransaction(data: TransactionResponse) {
    for (const row of data.content.list) {
      const quote = row.symbol.split('_')[1];

      if (this.quotes.indexOf(quote) < 0 || row.contQty === '0') {
        continue;
      }

      const timestamp = Math.floor(new Date(row.contDtm).getTime() / 60000) * 60000;
      const price = num(row.contPrice);
      const volume = num(row.contQty);

      const trades = this.getTrades(quote) || [];
      const currentTrade = trades.find(trade => trade.timestamp === timestamp);

      // make 1m candle stick
      if (currentTrade) {
        currentTrade.price = price;
        currentTrade.volume.plus(volume);
      } else {
        trades.push({ price, volume, timestamp });
      }

      this.setTrades(quote, trades);
      this.setPrice(quote, price);
    }

    this.isUpdated = true;
  }

  private async fetchLatestTrades(quote: string): Promise<Trades> {
    // get latest candles
    const response: CandlestickResponse = await nodeFetch(
      `https://www.bithumb.com/trade_history/chart_data?_=${Date.now()}`,
      {
        method: 'POST',
        headers: Object.assign(headers, { cookie: `csrf_xcoin_name=${requestData[quote].csrf_xcoin_name}` }),
        body: toFormData(requestData[quote]),
        timeout: this.options.timeout
      }
    ).then(res => res.json());

    if (!response || response.error !== '0000' || !Array.isArray(response.data) || response.data.length < 1) {
      throw new Error(`wrong response, ${response && JSON.stringify(response)}`);
    }

    return response.data.map(row => ({
      // the order is [time, open, close, high, low, volume]
      price: num(row[2]),
      volume: num(row[5]),
      timestamp: +row[0]
    }));
  }

  protected async update(): Promise<boolean> {
    if (this.isUpdated) {
      this.isUpdated = false;
      return true;
    }

    return false;
  }
}

export default Bithumb;
