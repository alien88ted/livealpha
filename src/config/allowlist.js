// Central allowlist of Twitter usernames (without @), all lowercase
// Gatekeeper for which accounts are tracked and analyzed

const ALLOWED_USERNAMES = [
	'apewoodx',
	'zimuth',
	'yukinthecut',
	'avgcryptoguy',
	'shockedjs',
	'basedshillbh',
	'izebel_eth',
	'knveth',
	'tmlevel0',
	'chang_defi',
	'earlyxbt',
	'cl207',
	'sokio8d',
	'0xracist',
	'user_baproll',
	'projectaeon3333',
	'spx6900',
	'insiliconot',
	'fapital3',
	'guthixhl',
	'33b345',
	'0xuberm',
	'trading_axe',
    'luckio',
    'eyearea',
    'worldlibertyfi',
    'cookerflips',
    'shockedjs'
];

function isAllowed(username) {
	if (!username) return false;
	return ALLOWED_USERNAMES.includes(String(username).toLowerCase());
}

function filterAllowed(usernames) {
	return Array.from(new Set((usernames || []).map(u => String(u).trim()).filter(isAllowed)));
}

module.exports = { ALLOWED_USERNAMES, isAllowed, filterAllowed };


