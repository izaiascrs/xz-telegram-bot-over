
type TradeStats = {
  trades: boolean[];
  winRate: number; 
}

type TradeAllStats = {
  win: number;
  loss: number;
  totalTrades: number;
  winRate: number;
}

export class TradeWinRateManger {
  private minVirtualTradeCount = 100;
  private minTradeCount = 100;
  private minVirtualTradeWinRate = 0.34; // 34%
  private winRateSignal = 0.40; // 38%
  private reachMinWinRate = false;
  private minTradeWinRate = 0.485; // 48.5%
  private virtualTradeStats: TradeStats = { trades: [], winRate: 0 };
  private tradeStats: TradeStats = { trades: [], winRate: 0 };
  private isAllowToTrade: boolean = false;
  private onTradeReach?: (tradeStats: TradeAllStats, type: "virtual" | "real") => void;

  constructor() {}

  setOnTradeReach(callback: (tradeStats: TradeAllStats, type: "virtual" | "real") => void) {
    this.onTradeReach = callback;
  };

  updateVirtualTradeStats(isWin: boolean) {
    if(this.isAllowToTrade) return;

    this.virtualTradeStats.trades.push(isWin);
    const tradesCount = this.virtualTradeStats.trades.length;

    if (tradesCount > this.minVirtualTradeCount) {
      this.virtualTradeStats.trades.shift();
    }

    this.virtualTradeStats.winRate = this.calculateWinRate(
      this.virtualTradeStats.trades
    );

    //const reachMinTrades = tradesCount >= this.minVirtualTradeCount;
    //const winRateLessThenMinWinRate = this.virtualTradeStats.winRate <= this.minVirtualTradeWinRate;

    // check if win rate is less or equal to 38%
    //if(reachMinTrades && winRateLessThenMinWinRate) {
     // this.reachMinWinRate = true;
   // }

    // check if reach min win rate and the current win rate is greater then 40%
   // if(this.reachMinWinRate && this.virtualTradeStats.winRate > this.winRateSignal) {
   //   this.isAllowToTrade = true;
   // }

     this.isAllowToTrade =
       tradesCount >= this.minVirtualTradeCount &&
       this.virtualTradeStats.winRate <= this.minVirtualTradeWinRate;

    if(this.isAllowToTrade && this.onTradeReach) {
      this.onTradeReach(this.getVirtualStats(), "virtual");
    }

    if(this.isAllowToTrade) {
      this.virtualTradeStats.trades = [];
      this.virtualTradeStats.winRate = 0;
      this.reachMinWinRate = false;
    }
  }

  updateTradeStats(isWin: boolean) {
    if(!this.isAllowToTrade) return;

    this.tradeStats.trades.push(isWin);
    const tradesCount = this.tradeStats.trades.length;

    this.tradeStats.winRate = this.calculateWinRate(
      this.tradeStats.trades
    );
    

    // between 50 and 70 trades and win rate less then 42.5%
    if(tradesCount > 50 && tradesCount < 70 && this.tradeStats.winRate < 0.425) {
      this.isAllowToTrade = false;
    }

    // 100 trades and win rate less then 48.5%
    if(tradesCount >= this.minTradeCount && this.tradeStats.winRate < this.minTradeWinRate) {
      this.isAllowToTrade = false;
    }

    if(!this.isAllowToTrade && this.onTradeReach) {
      this.onTradeReach(this.getTradeStats(), "real");
    }

    if(!this.isAllowToTrade) {
      this.tradeStats.trades = [];
      this.tradeStats.winRate = 0;
    }
  }

  getVirtualStats() {
    return this.generateStats(this.virtualTradeStats);
  }

  getTradeStats() {
    return this.generateStats(this.tradeStats);
  }

  canTrade() {
    return this.isAllowToTrade;
  }

  private generateStats(data: TradeStats): TradeAllStats {
    return data.trades.reduce((acc, isWin) => {
      acc.win += isWin ? 1: 0;
      acc.loss += !isWin ? 1: 0;
      acc.totalTrades += 1;
      acc.winRate = acc.win / acc.totalTrades;
      return acc;
    }, { win: 0, loss: 0, totalTrades: 0, winRate: 0 });
  }

  private calculateWinRate(trades: boolean[]) {
    const winCount = trades.reduce((acc, isWin) => (acc += isWin ? 1 : 0), 0);
    return winCount / trades.length;
  }
}

// const tradeWinRateManager = new TradeWinRateManger();
// Array.from({ length: 160 }).forEach(() => tradeWinRateManager.updateTradeStats(Math.random() > 0.54));

// console.log(tradeWinRateManager.getTradeStats());
// console.log(tradeWinRateManager.canTrade());
