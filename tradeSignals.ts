import { Liquidity, LiquidityPoolKeysV4, Percent, TokenAmount } from "@raydium-io/raydium-sdk";
import { logger, sleep } from "./helpers";
import { Connection } from "@solana/web3.js";
import { BotConfig } from "./bot";
import { TechnicalAnalysis } from "./technicalAnalysis";
import BN from "bn.js";
import { Messaging } from "./messaging";
import { TechnicalAnalysisCache } from "./cache/technical-analysis.cache";

export class TradeSignals {
    private readonly TA: TechnicalAnalysis;

    constructor(
        private readonly connection: Connection,
        readonly config: BotConfig,
        private readonly messaging: Messaging,
        private readonly technicalAnalysisCache: TechnicalAnalysisCache
    ) {
        this.TA = new TechnicalAnalysis(config);
    }

    public async waitForBuySignal(poolKeys: LiquidityPoolKeysV4) {
        if (!this.config.useTechnicalAnalysis) {
            return true;
        }

        this.technicalAnalysisCache.addNew(poolKeys.baseMint.toString(), poolKeys);

        logger.trace({ mint: poolKeys.baseMint.toString() }, `Waiting for buy signal`);

        const totalTimeToCheck = this.config.buySignalTimeToWait;
        const interval = this.config.buySignalPriceInterval;
        const maxSignalWaitTime = totalTimeToCheck * (this.config.buySignalFractionPercentageTimeToWait / 100);

        let startTime = Date.now();
        let timesChecked = 0;
        let previousRSI = null;

        do {
            try {
                let prices = this.technicalAnalysisCache.getPrices(poolKeys.baseMint.toString());

                if (prices == null) {
                    continue;
                }

                let currentRSI = this.TA.calculateRSIv2(prices);
                let macd = this.TA.calculateMACDv2(prices);

                if (previousRSI !== currentRSI) {
                    logger.trace({ 
                        mint: poolKeys.baseMint.toString()
                    }, `(${timesChecked}) Waiting for buy signal: RSI: ${currentRSI.toFixed(3)}, MACD: ${macd.macd}, Signal: ${macd.signal}`);
                    previousRSI = currentRSI;
                }

                if (((Date.now() - startTime) > maxSignalWaitTime) && prices.length < this.config.buySignalLowVolumeThreshold) {
                    logger.trace(`Not enough volume for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                    return false;
                }

                if (((Date.now() - startTime) > maxSignalWaitTime) && currentRSI == 0 && !macd.macd) {
                    logger.trace(`Not enough data for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                    return false;
                }

                if (currentRSI > 0 && currentRSI < 30 && macd.macd && macd.signal && macd.macd > macd.signal) {
                    logger.trace("RSI is less than 30, macd + signal = long, sending buy signal");
                    return true;
                }

            } catch (e) {
                logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
                continue;
            } finally {
                timesChecked++;
                await sleep(interval);
            }
        } while ((Date.now() - startTime) < totalTimeToCheck);

        return false;
    }

    public async waitForSellSignal(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
        this.technicalAnalysisCache.markAsDone(poolKeys.baseMint.toString());

        if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
            return true;
        }

        const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
        const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
        const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
        const takeProfit = this.config.quoteAmount.add(profitAmount);
        let stopLoss: TokenAmount;

        const slippage = new Percent(this.config.sellSlippage, 100);
        let timesChecked = 0;

        do {
            try {
                const poolInfo = await Liquidity.fetchInfo({
                    connection: this.connection,
                    poolKeys,
                });

                const amountOut = Liquidity.computeAmountOut({
                    poolKeys,
                    poolInfo,
                    amountIn: amountIn,
                    currencyOut: this.config.quoteToken,
                    slippage,
                }).amountOut as TokenAmount;

                logger.debug(
                    { mint: poolKeys.baseMint.toString() },
                    `${timesChecked}/${timesToCheck} Take profit: ${takeProfit.toFixed()} | Current: ${amountOut.toFixed()}`,
                );

                if (amountOut.gt(takeProfit)) {
                    return true;
                }

                await sleep(this.config.priceCheckInterval);
            } catch (e) {
                logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
            } finally {
                timesChecked++;
            }
        } while (timesChecked < timesToCheck);

        if (this.config.autoSellWithoutSellSignal) {
            return true;
        } else {
            await this.messaging.sendTelegramMessage(`🚫NO SELL🚫\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nTime ran out, sell stopped, you're a bagholder now`, poolKeys.baseMint.toString())
            return false;
        }
    }
}
