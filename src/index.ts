import "dotenv/config";
import { MoneyManagementV2 } from "./money-management/types";
import { TradeService } from "./database/trade-service";
import { initDatabase } from "./database/schema";
import { MoneyManager } from "./money-management/moneyManager";
import { getBackTestResults } from "./backtest";
import { schedule } from 'node-cron';
import { ContractStatus, TicksStreamResponse } from "@deriv/api-types";
import { TelegramManager } from "./telegram";
import apiManager from "./ws";
import { DERIV_TOKEN } from "./utils/constants";
import { ConfigOptimizer, LastTrade } from "./backtest/optmizer/config-optmizer";
import { TradeStateManager } from "./utils/trade-state-manager";

type TSymbol = (typeof symbols)[number];
const symbols = ["R_10"] as const;

const BALANCE_TO_START_TRADING = 100;
const CONTRACT_SECONDS = 2;

const config: MoneyManagementV2 = {
  type: "fixed",
  initialStake: 0.35,
  profitPercent: 137,
  maxStake: 100,
  maxLoss: 20,
  sorosLevel: 20,
  winsBeforeMartingale: 0,
  initialBalance: BALANCE_TO_START_TRADING,
  targetProfit: 100,
};

const tradeConfig = {
  entryDigit: 0,
  ticksCount: 1, 
}

let isAuthorized = false;
let isTrading = false;
let waitingVirtualLoss = false;
let consecutiveWins = 0;
let lastContractId: number | undefined = undefined;
let lastContractIntervalId: NodeJS.Timeout | null = null;
let tickCount = 0;

const lastTrade: LastTrade = {
  win: false,
  entryDigit: 0,
  resultDigit: 0,
  ticks: 0,
  digitsArray: [] as number[]
}

let subscriptions: {
  ticks?: any;
  contracts?: any;
} = {};

// Adicionar um array para controlar todas as subscrições ativas
let activeSubscriptions: any[] = [];

// Inicializar o banco de dados
const database = initDatabase();
const tradeService = new TradeService(database);
const telegramManager = new TelegramManager(tradeService);
const moneyManager = new MoneyManager(config, config.initialBalance);
const tradeStateManager = new TradeStateManager(2);

let optimizer: ConfigOptimizer | undefined = undefined;
let optimizerReady = false;
let retryToGetLastTradeCount = 0;

// Configura callback para quando atingir o lucro alvo
moneyManager.setOnTargetReached((profit, balance) => {
  const message = `🎯 Lucro alvo atingido!\n\n` +
    `💰 Lucro: $${profit.toFixed(2)}\n` +
    `🎯 Meta: $${config.targetProfit}\n` +
    `💵 Saldo: $${balance.toFixed(2)}\n\n` +
    `✨ Reiniciando sessão com saldo inicial de $${config.initialBalance.toFixed(2)}`;

  telegramManager.sendMessage(message);
});

const ticksMap = new Map<TSymbol, number[]>([]);

// running every 2 hours - America/Sao_Paulo
const task = schedule('0 */2 * * *', () => {
  telegramManager.sendMessage("⏳ Iniciando backtest...");
  getBackTestResults().then((loadedOptimizer) => {
    optimizerReady = true;
    optimizer = loadedOptimizer;
  });
},  {
  scheduled: false,
  timezone: "America/Sao_Paulo"
});

function createTradeTimeout() {
  lastContractIntervalId = setInterval(() => {
    if(lastContractId) {
      getLastTradeResult(lastContractId);
    }
  }, ((tradeConfig.ticksCount * CONTRACT_SECONDS) * 1000) * 30);
}

function clearTradeTimeout() {
  if(lastContractIntervalId) {
    clearInterval(lastContractIntervalId);
    lastContractIntervalId = null;
  }
}

function handleTradeResult({
  profit,
  stake,
  status,
  exit_tick_display_value,
  tick_stream,
}: {
  profit: number;
  stake: number;
  status: ContractStatus;
  exit_tick_display_value: string | undefined;
  tick_stream:  {
    epoch?: number;
    tick?: null | number;
    tick_display_value?: null | string;
  }[] | undefined
}) {

  if(status === "open") return;

  updateActivityTimestamp();
  const isWin = status === "won";

  const exitTickValue = exit_tick_display_value;
  const tickStream = tick_stream ?? [];
  const exitNumber = +((exitTickValue ?? '').slice(-1));
  const digitsArr = tickStream.map((t) => +((t.tick_display_value?? "").slice(-1))).slice(-2);

  // update last Trade
  lastTrade.win = isWin;
  lastTrade.entryDigit = tradeConfig.entryDigit;
  lastTrade.ticks = tradeConfig.ticksCount;
  lastTrade.resultDigit = exitNumber;
  lastTrade.digitsArray = digitsArr;

  const nextConfig = optimizer?.getNextConfig(lastTrade);

  if(nextConfig?.entryDigit !== undefined && nextConfig.ticks && !isWin) {
    tradeConfig.entryDigit = nextConfig.entryDigit;
    tradeConfig.ticksCount = nextConfig.ticks;
  }
  
  // Calcular novo saldo baseado no resultado
  const currentBalance = moneyManager.getCurrentBalance();
  let newBalance = currentBalance;

  isTrading = false;
  lastContractId = undefined;
  waitingVirtualLoss = false;
  
  if (isWin) {
    newBalance = currentBalance + profit;
    consecutiveWins++;
  } else {
    newBalance = currentBalance - stake;
    consecutiveWins = 0;
  }
  
  // moneyManager.updateBalance(Number(newBalance.toFixed(2)));
  moneyManager.updateLastTrade(isWin);
  telegramManager.updateTradeResult(isWin, moneyManager.getCurrentBalance());

  const resultMessage = isWin ? "✅ Trade ganho!" : "❌ Trade perdido!";
  telegramManager.sendMessage(
    `${resultMessage}\n` +
    `💰 ${isWin ? 'Lucro' : 'Prejuízo'}: $${isWin ? profit : stake}\n` +
    `💵 Saldo: $${moneyManager.getCurrentBalance().toFixed(2)}`
  );  

  // Salvar trade no banco
  tradeService.saveTrade({
    isWin,
    stake,
    profit: isWin ? profit : -stake,
    balanceAfter: newBalance
  }).catch(err => console.error('Erro ao salvar trade:', err));

  clearTradeTimeout();

  tradeStateManager.updateTradeResult(isWin);
}

async function getLastTradeResult(contractId: number | undefined) {
  if(!contractId) return;  
  if(retryToGetLastTradeCount >= 2) return;
  try {
    const data = await apiManager.augmentedSend('proposal_open_contract', { contract_id: contractId })
    const contract = data.proposal_open_contract;
    const profit = contract?.profit ?? 0;
    const stake = contract?.buy_price ?? 0;
    const status = contract?.status;
    const exit_tick_display_value = contract?.exit_tick_display_value;
    const tick_stream = contract?.tick_stream;
    retryToGetLastTradeCount = 0;
  
    handleTradeResult({
      profit,
      stake,
      status: status ?? "open",
      exit_tick_display_value,
      tick_stream
    });    
  } catch (error: any) {
    console.log("error trying to get last Trade!", error);
    const codeError = error?.error?.code;
    if(codeError && codeError === "AuthorizationRequired") {
      retryToGetLastTradeCount++;
      await authorize()
        .then(() => getLastTradeResult(contractId))
        .catch((err) => console.error("Error trying to login", err))
    }
  }

}

const checkStakeAndBalance = (stake: number) => {
  if (stake < 0.35 || moneyManager.getCurrentBalance() < 0.35) {
    telegramManager.sendMessage(
      "🚨 *ALERTA CRÍTICO*\n\n" +
        "❌ Bot finalizado automaticamente!\n" +
        "💰 Saldo ou stake chegou a zero\n" +
        `💵 Saldo final: $${moneyManager.getCurrentBalance().toFixed(2)}`
    );
    stopBot();
    return false;
  }
  return true;
};

const clearSubscriptions = async () => {
  try {
    // Limpar todas as subscrições ativas
    for (const subscription of activeSubscriptions) {
      if (subscription) {
        try {
          subscription.unsubscribe();
        } catch (error) {
          console.error("Erro ao limpar subscrição:", error);
        }
      }
    }
    
    // Limpar array de subscrições
    activeSubscriptions = [];
    
    // Limpar objeto de subscrições
    subscriptions = {};

    // Resetar todos os estados
    isTrading = false;
    waitingVirtualLoss = false;
    isAuthorized = false;
    ticksMap.clear();
    
  } catch (error) {
    console.error("Erro ao limpar subscrições:", error);
  }
};

const startBot = async () => {
  updateActivityTimestamp(); // Atualizar timestamp ao iniciar o bot
  await clearSubscriptions();
  task.start();

  getBackTestResults()
    .then((loadedOptimizer) => {
      optimizerReady = true;
      optimizer = loadedOptimizer;
    });

  if (!isAuthorized) {
    await authorize();
  }

  try {
    subscriptions.ticks = subscribeToTicks("R_10");
    subscriptions.contracts = subscribeToOpenOrders();
    
    if (!subscriptions.ticks || !subscriptions.contracts) {
      throw new Error("Falha ao criar subscrições");
    }

    telegramManager.sendMessage("🤖 Bot iniciado e conectado aos serviços Deriv");
  } catch (error) {
    console.error("Erro ao iniciar bot:", error);
    telegramManager.sendMessage("❌ Erro ao iniciar o bot. Tentando parar e limpar as conexões...");
    await stopBot();
  }
};

const stopBot = async () => {
  updateActivityTimestamp(); // Atualizar timestamp ao parar o bot
  await clearSubscriptions();
  task.stop();
  isTrading = false;
  retryToGetLastTradeCount = 0;
  telegramManager.sendMessage("🛑 Bot parado e desconectado dos serviços Deriv");
};

const subscribeToTicks = (symbol: TSymbol) => {
  const ticksStream = apiManager.augmentedSubscribe("ticks_history", {
    ticks_history: symbol,
    end: "latest",
    count: 21 as unknown as undefined,
  });

  const subscription = ticksStream.subscribe((data) => {
    updateActivityTimestamp(); // Atualizar timestamp ao receber ticks

    if (!telegramManager.isRunningBot()) {
      subscription.unsubscribe();
      const index = activeSubscriptions.indexOf(subscription);
      if (index > -1) {
        activeSubscriptions.splice(index, 1);
      }
      return;
    }

    if (data.msg_type === "history") {
      const ticksPrices = data.history?.prices || [];
      const digits = ticksPrices.map((price) => {
        return +price.toFixed(data?.pip_size).slice(-1);
      });
      ticksMap.set(symbol, digits);
    }

    if (data.msg_type === "tick") {
      const tickData = data as TicksStreamResponse;
      const currentPrice = +(tickData.tick?.quote || 0)
        .toFixed(tickData.tick?.pip_size)
        .slice(-1);

      const prevTicks = ticksMap.get(symbol) || [];
      if (prevTicks.length >= 5) {
        prevTicks.shift();
        prevTicks.push(currentPrice);
        ticksMap.set(symbol, prevTicks);
      }
    }

    const currentDigits = ticksMap.get(symbol) || [];
    const lastTick = currentDigits[currentDigits.length - 1];    

    if(!optimizerReady) return;

    if (!isAuthorized || !telegramManager.isRunningBot()) return;

    if(isTrading) {
      if(!tradeStateManager.canTrade()) {
        tickCount++;

        if(tickCount >= tradeConfig.ticksCount) {
          const isWin = lastTick > 5;
          lastTrade.win = isWin;
          lastTrade.entryDigit = tradeConfig.entryDigit;
          lastTrade.ticks = tradeConfig.ticksCount;
          lastTrade.resultDigit = lastTick;
          lastTrade.digitsArray = currentDigits.slice(-2);

          const nextConfig = optimizer?.getNextConfig(lastTrade);

          if(nextConfig?.entryDigit !== undefined && nextConfig.ticks && !isWin) {
            tradeConfig.entryDigit = nextConfig.entryDigit;
            tradeConfig.ticksCount = nextConfig.ticks;
          }

          tradeStateManager.updateTradeResult(isWin);

          isTrading = false;
        }
      }

      return;
    }
    
    if (lastTick === tradeConfig.entryDigit) {
      // console.log("NEW TRADE", { 
      //   canTrade: tradeStateManager.canTrade(),
      //   virtualLoss: tradeStateManager.getCurrentLossCount(),
      //   lossAverage: tradeStateManager.getLossAverage(),
      // });
      
      updateActivityTimestamp(); // Atualizar timestamp ao identificar sinal

      if(tradeStateManager.canTrade()) {
        let amount = moneyManager.calculateNextStake();
  
        if (!checkStakeAndBalance(amount)) {
          stopBot();
          return;
        }
  
        telegramManager.sendMessage(
          `🎯 Sinal identificado!\n` +
            `💰 Valor da entrada: $${amount.toFixed(2)}`
        );
  
        apiManager.augmentedSend("buy", {
          buy: "1",
          price: 100,
          parameters: {
            symbol,
            currency: "USD",
            basis: "stake",
            duration: tradeConfig.ticksCount,
            duration_unit: "t",
            amount: Number(amount.toFixed(2)),
            contract_type: "DIGITOVER",
            barrier: "5",
          },
        }).then((data) => {
          const contractId = data.buy?.contract_id;
          lastContractId = contractId;
          createTradeTimeout();
        });
      }

      isTrading = true;
    }
    
  });

  activeSubscriptions.push(subscription);
  return ticksStream;
};

const subscribeToOpenOrders = () => {
  const contractSub = apiManager.augmentedSubscribe("proposal_open_contract");
  
  const subscription = contractSub.subscribe((data) => {
    updateActivityTimestamp();

    if (!telegramManager.isRunningBot()) {
      subscription.unsubscribe();
      const index = activeSubscriptions.indexOf(subscription);
      if (index > -1) {
        activeSubscriptions.splice(index, 1);
      }
      return;
    }

    const contract = data.proposal_open_contract;
    const status = contract?.status;
    const profit = contract?.profit ?? 0;
    const stake = contract?.buy_price || 0;
    const exit_tick_display_value = contract?.exit_tick_display_value;
    const tick_stream = contract?.tick_stream;

    handleTradeResult({
      profit,
      stake,
      status: status ?? "open",
      exit_tick_display_value,
      tick_stream
    });

  });

  activeSubscriptions.push(subscription);
  return contractSub;
};

const authorize = async () => {
  try {
    await apiManager.authorize(DERIV_TOKEN);
    isAuthorized = true;
    telegramManager.sendMessage("🔐 Bot autorizado com sucesso na Deriv");
    return true;
  } catch (err) {
    isAuthorized = false;
    telegramManager.sendMessage("❌ Erro ao autorizar bot na Deriv");
    return false;
  }
};

// Adicionar verificação periódica do estado do bot
setInterval(async () => {
  if (telegramManager.isRunningBot() && !isTrading && !waitingVirtualLoss && moneyManager.getCurrentBalance() > 0) {
    // Verificar se o bot está "travado"
    const lastActivity = Date.now() - lastActivityTimestamp;
    if (lastActivity > (60_000 * 2)) { // 2 minutos sem atividade
      console.log("Detectado possível travamento do bot, resetando estados...");
      isTrading = false;
      waitingVirtualLoss = false;
      lastActivityTimestamp = Date.now();
      await clearSubscriptions();
    }
  }
}, (30_000)); // 30 seconds

// Adicionar timestamp da última atividade
let lastActivityTimestamp = Date.now();

// Atualizar o timestamp em momentos importantes
const updateActivityTimestamp = () => {
  lastActivityTimestamp = Date.now();
};

function main() {
  apiManager.connection.addEventListener("open", async () => {
    telegramManager.sendMessage("🌐 Conexão WebSocket estabelecida");
    authorize();
  });

  apiManager.connection.addEventListener("close", async () => {
    isAuthorized = false;
    await clearSubscriptions();
    telegramManager.sendMessage("⚠️ Conexão WebSocket fechada");
  });

  apiManager.connection.addEventListener("error", async (event) => {
    console.error("Erro na conexão:", event);
    telegramManager.sendMessage("❌ Erro na conexão com o servidor Deriv");
    await clearSubscriptions();
  });

  // Observadores do estado do bot do Telegram
  setInterval(async () => {
    if (telegramManager.isRunningBot() && !subscriptions.ticks) {
      await startBot();
    } else if (
      !telegramManager.isRunningBot() &&
      (subscriptions.ticks || subscriptions.contracts)
    ) {
      await stopBot();
    }
  }, 10_000);
}

main();
