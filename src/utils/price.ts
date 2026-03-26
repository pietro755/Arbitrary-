import axios from "axios";
import { logger } from "./logger.js";

/** Returns the current USD price for a CoinGecko coin ID. */
export async function fetchUsdPrice(coingeckoId: string): Promise<number> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
    const response = await axios.get<Record<string, { usd: number }>>(url, {
      timeout: 5000,
    });
    return response.data[coingeckoId]?.usd ?? 0;
  } catch (err) {
    logger.warn(`[PriceOracle] Failed to fetch ${coingeckoId} price: ${err}`);
    return 0;
  }
}

/** Returns SUI/USD price. Falls back to 1.0 if network call fails. */
export async function fetchSuiPrice(): Promise<number> {
  const price = await fetchUsdPrice("sui");
  return price > 0 ? price : 1.0;
}
