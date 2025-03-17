class LosesStats {
  private losesArr: number[] = [];
  private lossAverage = 0;
  private currentConsecutiveLosses = 0;
  private minLossAverage = 3;


  constructor(initialLosesAverage?: number) {
    this.lossAverage = initialLosesAverage ?? 0;
  }

  public updateLosesStats(isWin: boolean) {
    if (isWin) {
      if (this.currentConsecutiveLosses > 0) {
        this.losesArr.push(this.currentConsecutiveLosses);
        this.lossAverage = this.calculateLossAverage();
        this.currentConsecutiveLosses = 0;
      }
      return;
    }

    this.currentConsecutiveLosses++;
    this.lossAverage = this.calculateLossAverage();
  }

  public getLossAverage() {
    return Math.max(this.lossAverage, this.minLossAverage);
  }

  public reset() {
    this.losesArr = [];
    this.currentConsecutiveLosses = 0;
    this.lossAverage = 0;
  }

  private calculateLossAverage() {
    const totalLosses = this.losesArr.reduce((acc, v) => acc += v, 0);
    if(totalLosses <= 0) return 0;
    return Math.floor(totalLosses / this.losesArr.length);
  }
}

class VirtualLoss {
  private lossCount = 0;

  public updateLossCount(isWin: boolean = false) {
    if (isWin) {
      this.lossCount = 0; // Reseta a contagem se ganhar
    } else {
      this.lossCount++; // Incrementa a contagem se perder
    }
  }

  public getLossCount() {
    return this.lossCount;
  }

  public reset() {
    this.lossCount = 0;
  }
}

class LossManager {
  private losesStats: LosesStats;
  private virtualLoss: VirtualLoss;
  private isInVirtualLoss: boolean = false;
  private canTrade: boolean = true; // Variável para monitorar se podemos fazer entradas
  private hasWonAfterVirtualLoss: boolean = false; // Variável para verificar se ganhou após sair do loss virtual

  constructor(initialLosesAverage: number) {
    this.losesStats = new LosesStats(initialLosesAverage);
    this.virtualLoss = new VirtualLoss();
  }

  public updateLoss(isWin: boolean) {
    if (this.isInVirtualLoss) {
      this.virtualLoss.updateLossCount(isWin);
      if (this.virtualLoss.getLossCount() >= this.losesStats.getLossAverage()) {
        this.isInVirtualLoss = false; // Sai do modo de perda virtual
        this.canTrade = true; // Permite negociar novamente
        this.virtualLoss.reset(); // Reseta a contagem de perdas
      }
    } else {
      this.losesStats.updateLosesStats(isWin);
      if (!isWin) {
        if (this.hasWonAfterVirtualLoss) {
          this.isInVirtualLoss = true; // Entra em modo de perda virtual após uma perda se já ganhou após sair do loss virtual
          this.canTrade = false; // Não permite negociar em modo de perda virtual
          this.hasWonAfterVirtualLoss = false; // Reseta o estado de ganho após sair do loss virtual
        }
      } else {
        this.hasWonAfterVirtualLoss = true; // Marca que ganhou após sair do loss virtual
      }
    }
  }

  public canTradeNow(): boolean {
    return this.canTrade;
  }

  public reset() {
    this.losesStats.reset();
    this.virtualLoss.reset();
    this.isInVirtualLoss = false;
    this.canTrade = true;
    this.hasWonAfterVirtualLoss = false;
  }

  public getLossAverage() {
    return this.losesStats.getLossAverage();
  }

  public getCurrentLossCount() {
    return this.virtualLoss.getLossCount();
  }
}

export class TradeStateManager {
  private lossManager: LossManager;

  constructor(initialLosesAverage: number) {
    this.lossManager = new LossManager(initialLosesAverage);
  }

  public updateTradeResult(isWin: boolean) {
    this.lossManager.updateLoss(isWin);
  }

  public canTrade(): boolean {
    return this.lossManager.canTradeNow();
  }

  public reset() {
    this.lossManager.reset();
  }

  public getLossAverage() {
    return this.lossManager.getLossAverage();
  }

  public getCurrentLossCount() {
    return this.lossManager.getCurrentLossCount();
  }
}

// const tradeStateManager = new TradeStateManager(3);
// Sequência de testes
// const testResults = [true, false, false, false,true, false, false, false, true, false, false, false, false, false, false, false, true, false]; // Começa com uma entrada válida
// testResults.forEach((result, index) => {
//   tradeStateManager.updateTradeResult(result);
//   console.log(`Resultado da entrada ${index + 1}: ${result ? 'Ganho' : 'Perda'}`);
//   console.log(`Pode negociar: ${tradeStateManager.canTrade()}`);
//   console.log(`Média de perdas: ${tradeStateManager.getLossAverage()}`);
//   console.log(`Contagem de perdas atuais: ${tradeStateManager.getCurrentLossCount()}`);
//   console.log('-----------------------------------');
// });
