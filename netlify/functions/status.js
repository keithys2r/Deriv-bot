// status.js
// Read-only endpoint the frontend polls to show real live data.
// Does NOT connect to Deriv, does NOT place trades - just reads memory.js.

const memory = require('./memory');

exports.handler = async function () {
  try {
    const state = await memory.loadState('rise_fall');
    const activeTrade = await memory.getActiveTrade('rise_fall');
    const lastTrade = await memory.getLastTrade('rise_fall');

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
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
