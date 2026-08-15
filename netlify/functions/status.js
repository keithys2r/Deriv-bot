// status.js
// Read-only endpoint the frontend polls to show real live data.
// Does NOT connect to Deriv, does NOT place trades - just reads memory.js.

const memory = require('./memory');

exports.handler = async function () {
  try {
    const settings = await memory.loadSettings();
    const strategyName = settings.activeStrategy || 'rise_fall';

    const state = await memory.loadState(strategyName);
    const activeTrade = await memory.getActiveTrade(strategyName);
    const lastTrade = await memory.getLastTrade(strategyName);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        activeStrategy: strategyName,
        running: !state.manualPause,
        manualPause: state.manualPause,
        cooldownPaused: state.paused,
        pausedUntil: state.pausedUntil,
        dailyProfit: state.dailyProfit,
        dailyLoss: state.dailyLoss,
        netProfit: state.dailyProfit - state.dailyLoss,
        wins: state.wins,
        losses: state.losses,
        tradesToday: state.tradesToday,
        winRate: state.tradesToday > 0 ? (state.wins / state.tradesToday) * 100 : 0,
        lastTradeResult: state.lastTradeResult,
        recentEvents: state.recentEvents || [],
        lastUpdated: state.lastUpdated,
        activeTrade: activeTrade || null,
        lastTrade: lastTrade || null
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
