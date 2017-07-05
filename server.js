"use strict";

/*
	A simple-minded IRC server written as an exercise in NodeJS.
	See https://modern.ircdocs.horse for useful docs.

	Some notes:

	A message may or may not have a prefix. If it does,
	the prefix must start with a colon.

	The final parameter in a list of parameters can be
	indicated with a colon also. It is the only parameter
	that can contain spaces.

	Numeric replies seem to be in format:
		:[server] [number] [recipient's nick] [other parameters]

	Internally, we always store channel names with a leading "#".
*/

const net = require("net");

const SERVER = "127.0.0.1";
const PORT = 6667;
const SOFTWARE = "simple_node_irc";

const STARTUP_TIME = (new Date()).toTimeString();

// ---------------------------------------------------------------------------------------------------

function is_alphanumeric(str) {
	let i;

	for (i = 0; i < str.length; i += 1) {
		let code = str.charCodeAt(i);
		if (((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) === false) {
			return false;
		}
	}
	return true;	// returns true on empty string
}

function nick_is_legal(str) {
	return str.length > 0 && is_alphanumeric(str);
}

function user_is_legal(str) {
	return str.length > 0 && is_alphanumeric(str);
}

function chan_is_legal(str) {
	if (str.charAt(0) !== "#") {
		return false;
	}
	if (str.length > 1 && is_alphanumeric(str.slice(1))) {
		return true;
	}
	return false;
}

function sanitize_channel_name(str) {

	// Remove leading colon if present, and make sure channel name starts with "#"
	// but do no other tests for legality.

	if (str.charAt(0) === ":") {
		str = str.slice(1);
	}
	if (str.charAt(0) !== "#") {
		str = "#" + str;
	}
	return str;
}

// ---------------------------------------------------------------------------------------------------

function make_channel(chan_name) {

	let channel = {
		connections: []
	};

	channel.remove_conn = (conn) => {
		channel.raw_send_all(`:${conn.id()} PART ${chan_name}`);

		while (1) {
			let index = channel.connections.indexOf(conn);
			if (index !== -1) {
				channel.connections.splice(index, 1);
			} else {
				break;
			}
		}
	};

	channel.user_present = (conn) => {
		let index = channel.connections.indexOf(conn);
		if (index !== -1) {
			return true;
		}
		return false;
	};

	channel.add_conn = (conn) => {
		if (channel.user_present(conn) === false) {
			channel.connections.push(conn);
			channel.raw_send_all(`:${conn.id()} JOIN ${chan_name}`);
		}
	};

	channel.raw_send_all = (msg) => {
		channel.connections.forEach((conn) => {
			conn.write(msg + "\r\n");
		});
	};

	channel.normal_message = (conn, msg) => {

		if (msg.charAt(0) !== ":") {
			msg = ":" + msg;
		}

		if (msg.length < 2) {
			return;
		}

		let source = conn.id();

		channel.connections.forEach((out_conn) => {
			if (conn !== out_conn) {
				out_conn.write(`:${source} PRIVMSG ${chan_name} ${msg}` + "\r\n");
			}
		});
	};

	channel.name_reply = (conn) => {

		let all_nicks = [];

		channel.connections.forEach((conn) => {
			all_nicks.push(conn.nick);
		});

		conn.numeric(353, `= ${chan_name} :` + all_nicks.join(" "));
		conn.numeric(366, `${chan_name} :End of /NAMES list`);
	};

	return channel;
}

// ---------------------------------------------------------------------------------------------------

function make_irc_server() {

	// Use Object.create(null) when using an object as a map
	// to avoid issued with prototypes.

	let irc = {
		nicks: Object.create(null),			// nick --> conn object
		channels: Object.create(null)		// chan_name --> channel object
	};

	irc.nick_in_use = (nick) => {
		if (irc.nicks[nick]) {
			return true;
		} else {
			return false;
		}
	};

	irc.remove_conn = (conn) => {
		conn.part_all_channels();
		delete irc.nicks[conn.nick];
	};

	irc.add_conn = (conn) => {				// Should be called just once per client, as soon as conn.nick is set.
		irc.nicks[conn.nick] = conn;
	};

	irc.change_nick = (conn, old_nick, new_nick) => {

		irc.nicks[new_nick] = irc.nicks[old_nick];
		delete irc.nicks[old_nick];

		// Figure out who has to be told about this...

		let all_recipients = Object.create(null);

		Object.keys(conn.channels).forEach((chan_name) => {

			let channel = conn.channels[chan_name];

			channel.connections.forEach((conn) => {
				all_recipients[conn.nick] = conn;
			});
		});

		let source = `${old_nick}!${conn.user}@${conn.address}`;

		Object.keys(all_recipients).forEach((out_nick) => {
			let out_conn = irc.nicks[out_nick];
			out_conn.write(`:${source} NICK ${new_nick}` + "\r\n");
		});
	};

	irc.get_channel = (chan_name) => {
		return irc.channels[chan_name];		// Can return undefined
	};

	irc.get_or_make_channel = (chan_name) => {
		if (irc.channels[chan_name] === undefined) {
			irc.channels[chan_name] = make_channel(chan_name);
		}
		return irc.channels[chan_name];
	};

	return irc;
}

// ---------------------------------------------------------------------------------------------------

function new_connection(irc, handlers, socket) {

	// In principle, having some base object to inherit from is possible,
	// but it would require a bit of work since the closure causes issues.

	let conn;

	// Setup socket actions...

	socket.on("data", (data) => {
		let lines = data.toString().split("\n");
		lines.forEach((line) => {
			conn.handle_line(line);
		});
	});

	socket.on("close", () => {
		irc.remove_conn(conn);				// this will call conn.part_all_channels()
	});

	socket.on("error", () => {
		return;
	});

	// Setup the conn object...
	// Use Object.create(null) when using an object as a map

	conn = {
		nick: undefined,
		user: undefined,
		socket : socket,
		address : socket.remoteAddress,		// good to cache this I think
		channels : Object.create(null)		// chan_name --> channel object
	};

	conn.id = () => {
		return `${conn.nick}!${conn.user}@${conn.address}`;
	};

	conn.write = (msg) => {
		conn.socket.write(msg);
	};

	conn.numeric = (n, msg) => {			// Send a numeric reply to the client...

		n = n.toString();

		while (n.length < 3) {
			n = "0" + n;
		}

		let nick = conn.nick || "*";		// i.e. use "*" if nick is undefined

		conn.write(`:${SERVER} ${n} ${nick} ${msg}` + "\r\n");

		// Is this right? We always send the receiver's nick? I suspect it is,
		// i.e. in multiple-server scenarios this is probably used when sending
		// a message via another server, to identify the recipient.
	};

	conn.join = (chan_name) => {

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		if (conn.channels[chan_name] !== undefined) {		// We're already in this channel
			return;
		}

		let channel = irc.get_or_make_channel(chan_name);

		conn.channels[chan_name] = channel;

		channel.add_conn(conn);
		channel.name_reply(conn);							// Send a RPL_NAMREPLY to the client (list of users in channel)
	};

	conn.part = (chan_name) => {

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		let channel = conn.channels[chan_name];

		if (channel === undefined) {
			return;
		}

		channel.remove_conn(conn);
		delete conn.channels[chan_name];
	};

	conn.part_all_channels = () => {
		Object.keys(conn.channels).forEach((chan_name) => {
			conn.part(chan_name);
		});
	};

	conn.welcome = () => {
		conn.numeric(1, `:Welcome to the server!`);
		conn.numeric(2, `:Your host is ${SERVER}, running ${SOFTWARE}`);
		conn.numeric(3, `:This server started up at ${STARTUP_TIME}`);
	};

	conn.handle_line = (msg) => {

		console.log(conn.id() + " ... " + msg);

		let tokens = msg.split(" ");

		if (tokens.length === 0) {
			return;
		}

		if (tokens[0].charAt(0) === ":") {		// The client sent a prefix, which we can ignore.
			tokens = tokens.slice(1);
		}

		// Ignore most commands if we haven't finished registration...

		if (tokens[0] !== "NICK" && tokens[0] !== "USER" && (conn.nick === undefined || conn.user === undefined)) {
			return;
		}

		// Dynamically call one of the "handle_XYZ" functions...

		let handler = handlers["handle_" + tokens[0]];

		if (typeof(handler) === "function") {
			handler(irc, conn, msg, tokens);
		}
	};
}

// ---------------------------------------------------------------------------------------------------
// Handlers are defined as methods in an object so they can be dynamically called easily.

function make_handlers() {

	let handlers = {};

	handlers.handle_NICK = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			conn.numeric(431, ":No nickname given");
			return;
		}

		let requested_nick = tokens[1];

		if (requested_nick.charAt(0) === ":") {								// I've seen mIRC do this sometimes
			requested_nick = requested_nick.slice(1);
		}

		if (nick_is_legal(requested_nick) === false) {
			conn.numeric(432, ":Erroneus nickname");
			return;
		}

		if (irc.nick_in_use(requested_nick) ) {
			conn.numeric(433, ":Nickname is already in use");
			return;
		}

		let old_nick = conn.nick;

		conn.nick = tokens[1];

		if (old_nick !== undefined) {
			irc.change_nick(conn, old_nick, conn.nick);
		} else {
			irc.add_conn(conn);		// This can be done even before conn.user is set.
		}

		if (old_nick === undefined && conn.user !== undefined) {			// We just completed registration
			conn.welcome();
		}
	};

	handlers.handle_USER = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		if (user_is_legal(tokens[1]) === false) {
			return;
		}

		if (conn.user !== undefined) {										// Can't change user after it's set
			return;
		}

		conn.user = tokens[1];

		if (conn.nick !== undefined) {										// We just completed registration
			conn.welcome();
		}
	};

	handlers.handle_JOIN = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.join(chan_name);
	};

	handlers.handle_PART = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.part(chan_name);
	};

	handlers.handle_PRIVMSG = (irc, conn, msg, tokens) => {

		if (tokens.length < 3) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		let channel = conn.channels[chan_name];

		if (channel === undefined) {
			return;
		}

		let s = tokens.slice(2).join(" ");
		channel.normal_message(conn, s);
	};

	handlers.handle_WHOIS = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let target = irc.nicks[tokens[1]];

		if (target === undefined) {
			conn.numeric(401, `${tokens[1]} :No such nick`);
			return;
		}

		// FIXME: there's some more stuff we're supposed to send...

		conn.numeric(311, `${target.nick} ${target.user} ${target.address} * :${target.user}`);
		conn.numeric(318, `${target.nick} :End of /WHOIS list`);
	};

	handlers.handle_PING = (irc, conn, msg, tokens) => {
		conn.write(`PONG ${SERVER} ${conn.address}` + "\r\n");
	};

	return handlers;
}

// ---------------------------------------------------------------------------------------------------

function main() {

	let irc = make_irc_server();
	let handlers = make_handlers();

	let server = net.createServer((socket) => {
		new_connection(irc, handlers, socket);
	});

	server.listen(PORT, SERVER);
}

// ---------------------------------------------------------------------------------------------------

main();
