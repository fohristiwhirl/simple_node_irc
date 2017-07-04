"use strict";

// A simple-minded IRC server written as an exercise in NodeJS.
// See https://modern.ircdocs.horse for useful docs.

const net = require("net");

const SERVER = "127.0.0.1";
const PORT = 6667;

const WELCOME_MSG = ":Welcome to the server!";

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

function ensure_leading_hash(str) {
	if (str.charAt(0) !== "#") {
		str = "#" + str;
	}
	return str;
}

// ---------------------------------------------------------------------------------------------------

function make_channel(chan_name) {

	let channel = {
		connections: Object.create(null)
	};

	channel.remove_conn = (conn) => {
		channel.raw_send_all(`${conn.id()} PART ${chan_name}`);
		delete channel.connections[conn.nick];
	};

	channel.add_conn = (conn) => {
		channel.connections[conn.nick] = conn;
		channel.raw_send_all(`${conn.id()} JOIN ${chan_name}`);
	};

	channel.raw_send_all = (msg) => {
		Object.keys(channel.connections).forEach((nick) => {
			let conn = channel.connections[nick];
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

		Object.keys(channel.connections).forEach((nick) => {
			if (nick !== conn.nick) {
				let out_conn = channel.connections[nick];
				out_conn.write(`${conn.id()} PRIVMSG ${chan_name} ${msg}` + "\r\n");
			}
		});
	};

	channel.name_reply = (conn) => {
		conn.numeric(353, `= ${chan_name} :` + Object.keys(channel.connections).join(" "));
		conn.numeric(366, `${chan_name} :End of NAMES list`);
	};

	return channel;
}

// ---------------------------------------------------------------------------------------------------

function make_irc_server() {

	// Use Object.create(null) when using an object as a map
	// to avoid issued with prototypes.

	let i = {
		nicks: Object.create(null),
		channels: Object.create(null)
	};

	i.nick_in_use = (nick) => {
		if (i.nicks[nick]) {
			return true;
		} else {
			return false;
		}
	};

	i.remove_conn = (conn) => {
		delete i.nicks[conn.nick];
	};

	i.add_conn = (conn) => {
		i.nicks[conn.nick] = conn;
	};

	i.get_channel = (chan_name) => {
		return i.channels[chan_name];		// Can return undefined
	};

	i.get_or_make_channel = (chan_name) => {
		if (i.channels[chan_name] === undefined) {
			i.channels[chan_name] = make_channel(chan_name);
		}
		return i.channels[chan_name];
	};

	return i;
}

// ---------------------------------------------------------------------------------------------------

function new_connection(irc, input_handlers, socket) {

	let conn;

	// Setup socket actions...

	socket.on("data", (data) => {
		let lines = data.toString().split("\n");
		lines.forEach((line) => {
			conn.handle_line(line);
		});
	});

	socket.on("close", () => {
		conn.part_all_channels();
	});

	socket.on("error", () => {
		return;
	});

	// Setup the conn object...

	conn = {
		nick: undefined,
		user: undefined,
		socket : socket,
		channels : Object.create(null)		// Use Object.create(null) when using an object as a map
	};

	conn.id = () => {
		return `:${conn.nick}!${conn.user}@${conn.socket.remoteAddress}`;
	};

	conn.write = (msg) => {
		conn.socket.write(msg);
	};

	conn.numeric = (n, msg) => {

		n = n.toString();

		while (n.length < 3) {
			n = "0" + n;
		}

		let username = conn.nick || "*";

		conn.write(`:${SERVER} ${n} ${username} ${msg}` + "\r\n");
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

	conn.handle_line = (msg) => {

		console.log(conn.id() + " ... " + msg);

		let tokens = msg.split(" ");

		// Ignore lines if we haven't finished registration...

		if (tokens[0] !== "NICK" && tokens[0] !== "USER" && (conn.nick === undefined || conn.user === undefined)) {
			return;
		}

		// Dynamically call one of the "handle_XYZ" functions...

		let handler = input_handlers["handle_" + tokens[0]];

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
			return;
		}

		if (nick_is_legal(tokens[1]) === false) {
			conn.numeric(432, ":Erroneus nickname");
			return;
		}

		if (irc.nick_in_use(tokens[1]) ) {
			conn.numeric(433, ":Nickname is already in use");
			return;
		}

		let had_nick_already = (conn.nick !== undefined);

		irc.remove_conn(conn);
		conn.nick = tokens[1];
		irc.add_conn(conn);

		if (had_nick_already === false && conn.user !== undefined) {		// We just completed registration
			conn.numeric(1, WELCOME_MSG);
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
			conn.numeric(1, WELCOME_MSG);
		}
	};

	handlers.handle_JOIN = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = ensure_leading_hash(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.join(chan_name);
	};

	handlers.handle_PART = (irc, conn, msg, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = ensure_leading_hash(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.part(chan_name);
	};

	handlers.handle_PRIVMSG = (irc, conn, msg, tokens) => {

		if (tokens.length < 3) {
			return;
		}

		let chan_name = ensure_leading_hash(tokens[1]);

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
