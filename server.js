"use strict";

/*
	A simple-minded IRC server written as an exercise in NodeJS.
	See https://modern.ircdocs.horse for useful docs.

	NOTES:

	A message may or may not have a prefix. If it does,
	the prefix must start with a colon.

	The final parameter in a list of parameters can be
	indicated with a colon also. It is the only parameter
	that can contain spaces.

	Numeric replies seem to be in format:
		:[server] [number] [recipient's nick] [other parameters]

	Internally, we always store channel names with a leading "#".

	Use Object.create(null) when using an object as a map to avoid
	issues with prototypes.

	In principle, having some base objects (i.e. for conns or
	channels) to inherit from is possible, but it would require a
	bit of work since the closures cause issues.
*/

const net = require("net");

const SOFTWARE = "Simple Node IRC";
const SERVER = "127.0.0.1";
const PORT = 6667;

const LOG_ALL = true;

const STARTUP_TIME = (new Date()).toTimeString();

// ---------------------------------------------------------------------------------------------------

function values(obj) {												// Like Object.values() I think.
	let list = [];

	for (let key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {		// Works even for prototype-less objects that don't have hasOwnProperty() available
			list.push(obj[key]);
		}
	}

	return list;
}

function is_alphanumeric(str) {
	for (let i = 0; i < str.length; i += 1) {
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

function sanitize_channel_name(str) {	// Make sure name starts with "#", but no legality checks
	if (str.charAt(0) !== "#") {
		str = "#" + str;
	}
	return str;
}

function tokenize_line_from_client(msg) {

	// Some subtleties due to the IRC format.
	// In particular, there can be a source at the start (starts with a colon).
	// There can also be a space-containing final parameter (also starts with a colon).

	msg = msg.trim();

	if (msg === "") {
		return [];
	}

	if (msg.charAt(0) === ":") {

		// Get rid of this source token...

		let first_space_index = msg.indexOf(" ");

		if (first_space_index === -1) {
			return [];
		}

		msg = msg.slice(first_space_index);
	}

	let mid_colon_index = msg.indexOf(":");

	let final_token;										// May remain undefined
	let main_msg = msg;										// Will become the part of the message before the colon (if there is one)

	if (mid_colon_index > -1) {
		final_token = msg.slice(mid_colon_index + 1);		// Possibly "" (empty string) or space-containing string
		main_msg = msg.slice(0, mid_colon_index);
	}

	let tokens = main_msg.split(" ");
	tokens = tokens.filter((item) => (item !== ""));		// Get rid of empty strings...

	if (final_token !== undefined) {
		tokens.push(final_token);							// This can be empty string, so add it after the above filter.
	}

	return tokens;
}

// ---------------------------------------------------------------------------------------------------

function make_channel(chan_name) {

	// Channels aren't notified if a user's nick changes,
	// so the keys to the conn map have to be a uid.

	let channel = {
		conns: Object.create(null)		// map: uid --> conn
	};

	channel.conn_list = () => {
		return values(channel.conns);
	};

	channel.nick_list = () => {
		let ret = [];
		channel.conn_list().forEach((conn) => {
			ret.push(conn.nick);
		});
		return ret;
	};

	channel.remove_conn = (conn, silent) => {
		if (channel.conns[conn.uid] !== undefined) {
			if (silent === false || silent === undefined) {
				channel.raw_send_all(`:${conn.source()} PART ${chan_name}`);
			}
			delete channel.conns[conn.uid];
		}
	};

	channel.user_present = (conn) => {
		return channel.conns[conn.uid] !== undefined;
	};

	channel.add_conn = (conn) => {
		if (channel.user_present(conn) === false) {
			channel.conns[conn.uid] = conn;
			channel.raw_send_all(`:${conn.source()} JOIN ${chan_name}`);
		}
	};

	channel.raw_send_all = (msg) => {
		channel.conn_list().forEach((conn) => {
			conn.write(msg + "\r\n");
		});
	};

	channel.normal_message = (conn, msg) => {

		if (msg.length < 1) {
			return;
		}

		let source = conn.source();

		channel.conn_list().forEach((out_conn) => {
			if (conn !== out_conn) {
				out_conn.write(`:${source} PRIVMSG ${chan_name} :${msg}` + "\r\n");
			}
		});
	};

	channel.name_reply = (conn) => {
		conn.numeric(353, `= ${chan_name} :` + channel.nick_list().join(" "));
		conn.numeric(366, `${chan_name} :End of /NAMES list`);
	};

	channel.topic_reply = (conn) => {
		conn.numeric(331, `${chan_name} :No topic is set`);
	};

	return channel;
}

// ---------------------------------------------------------------------------------------------------

function make_irc_server() {

	// The canonical list of who is connected and what channels exist.

	let irc = {
		conns: Object.create(null),			// map: nick --> conn object
		channels: Object.create(null),		// map: chan_name --> channel object
	};

	let next_id = 0;

	irc.new_id = () => {
		next_id += 1;
		return next_id - 1;
	};

	irc.nick_in_use = (nick) => {
		if (irc.conns[nick] !== undefined) {
			return true;
		}
		return false;
	};

	irc.conn_from_nick = (nick) => {
		return irc.conns[nick];				// Can return undefined
	};

	irc.disconnect = (conn, reason) => {

		if (conn === undefined || irc.conns[conn.nick] === undefined) {
			return;
		}

		reason = reason || "";

		let all_viewers = conn.viewer_list();

		conn.part_all_channels(true);		// Do this AFTER getting the viewer list

		all_viewers.forEach((out_conn) => {
			out_conn.write(`:${conn.source()} QUIT :${reason}` + "\r\n");
		});

		delete irc.conns[conn.nick];
	};

	irc.add_conn = (conn) => {				// Should be called once per client, as soon as conn.nick is set
		irc.conns[conn.nick] = conn;
	};

	irc.set_first_nick = (conn, new_nick) => {

		// The caller should already have checked legality.
		// That way it can send the client an appropriate error.

		if (irc.nick_in_use(new_nick) || nick_is_legal(new_nick) === false) {
			return;
		}

		conn.nick = new_nick;
		irc.add_conn(conn);
	};

	irc.change_nick = (conn, old_nick, new_nick) => {

		// The caller should already have checked legality.
		// That way it can send the client an appropriate error.

		if (irc.nick_in_use(new_nick) || nick_is_legal(new_nick) === false) {
			return;
		}

		// Tell everyone who can see the user about this...

		let all_recipients = conn.viewer_list();

		all_recipients.forEach((out_conn) => {
			out_conn.write(`:${conn.source()} NICK ${new_nick}` + "\r\n");		// Note that conn hasn't been updated yet so conn.source() correctly gives the old source.
		});

		irc.conns[new_nick] = conn;
		delete irc.conns[old_nick];
		conn.nick = new_nick;
	};

	irc.get_or_make_channel = (chan_name) => {
		if (chan_is_legal(chan_name) === false) {
			return undefined;
		}
		if (irc.channels[chan_name] === undefined) {
			irc.channels[chan_name] = make_channel(chan_name);
		}
		return irc.channels[chan_name];
	};

	return irc;
}

// ---------------------------------------------------------------------------------------------------

function new_connection(irc, handlers, socket) {

	let conn;

	// Setup socket actions...

	socket.on("data", (data) => {
		let lines = data.toString().split("\n");
		lines.forEach((line) => {
			conn.handle_line(line);
		});
	});

	socket.on("close", () => {
		irc.disconnect(conn, undefined);	// this will call conn.part_all_channels()
	});

	socket.on("error", () => {
		return;
	});

	// Setup the conn object...

	conn = {
		nick: undefined,
		user: undefined,
		socket : socket,
		address : socket.remoteAddress,		// good to cache this I think
		uid: irc.new_id(),
		channels : Object.create(null)		// map: chan_name --> channel object
	};

	conn.source = () => {
		return `${conn.nick}!${conn.user}@${conn.address}`;
	};

	conn.channel_name_list = () => {
		return Object.keys(conn.channels);
	};

	conn.channel_list = () => {
		return values(conn.channels);
	};

	conn.viewer_list = () => {					// Return a list of conns that can see this client (i.e. in channels).

		let all_viewers = Object.create(null);	// Using this as a map so that things can only be in it once: nick --> conn

		all_viewers[conn.nick] = conn;			// Always include self.

		conn.channel_list().forEach((channel) => {
			channel.conn_list().forEach((other_conn) => {
				all_viewers[other_conn.nick] = other_conn;
			});
		});

		return values(all_viewers);				// Note we return an array of conn objects, not the map above.
	};

	conn.write = (msg) => {
		conn.socket.write(msg);
	};

	conn.numeric = (n, msg) => {				// Send a numeric reply to the client...

		n = n.toString();

		while (n.length < 3) {
			n = "0" + n;
		}

		let nick = conn.nick || "*";			// i.e. use "*" if nick is undefined

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

		if (channel === undefined) {						// Should be impossible
			return;
		}

		conn.channels[chan_name] = channel;

		channel.add_conn(conn);
		channel.name_reply(conn);							// Send a RPL_NAMREPLY to the client (list of users in channel)
		channel.topic_reply(conn);							// Send a RPL_NOTOPIC or RPL_TOPIC to the client
	};

	conn.part = (chan_name, silent) => {

		let channel = conn.channels[chan_name];

		if (channel === undefined) {
			return;
		}

		channel.remove_conn(conn, silent);
		delete conn.channels[chan_name];
	};

	conn.part_all_channels = (silent) => {
		conn.channel_name_list().forEach((chan_name) => {
			conn.part(chan_name, silent);
		});
	};

	conn.welcome = () => {
		conn.numeric(1, `:Welcome to the server!`);
		conn.numeric(2, `:Your host is ${SERVER}, running ${SOFTWARE}`);
		conn.numeric(3, `:This server started up at ${STARTUP_TIME}`);
	};

	conn.whois_reply = (requester) => {

		// Reply to a WHOIS about this client.
		// FIXME: there's some more stuff we're supposed to send...

		requester.numeric(311, `${conn.nick} ${conn.user} ${conn.address} * :${conn.user}`);
		requester.numeric(318, `${conn.nick} :End of /WHOIS list`);
	};

	conn.handle_line = (msg) => {

		if (LOG_ALL && msg.trim() !== "") {
			console.log("\n" + conn.source() + "\n   " + msg);
		}

		let tokens = tokenize_line_from_client(msg);

		if (tokens.length === 0) {
			return;
		}

		// Ignore most commands if we haven't finished registration...

		if (tokens[0] !== "NICK" && tokens[0] !== "USER" && (conn.nick === undefined || conn.user === undefined)) {
			conn.numeric(451, ":You have not registered");
			return;
		}

		// Dynamically call one of the "handle_XYZ" functions...

		let handler = handlers["handle_" + tokens[0]];

		if (typeof(handler) === "function") {
			handler(irc, conn, tokens);
		}
	};
}

// ---------------------------------------------------------------------------------------------------
// Handlers are defined as methods in an object so they can be dynamically called easily.

function make_handlers() {

	let handlers = {};

	handlers.handle_NICK = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			conn.numeric(431, ":No nickname given");
			return;
		}

		let requested_nick = tokens[1];

		if (nick_is_legal(requested_nick) === false) {
			conn.numeric(432, ":Erroneus nickname");
			return;
		}

		if (irc.nick_in_use(requested_nick) ) {
			conn.numeric(433, ":Nickname is already in use");
			return;
		}

		let old_nick = conn.nick;

		if (old_nick !== undefined) {
			irc.change_nick(conn, old_nick, requested_nick);
		} else {
			irc.set_first_nick(conn, requested_nick);
		}

		// The above call should have set conn.nick. If it somehow didn't...

		if (conn.nick !== requested_nick) {
			conn.numeric(400, ":Seemingly valid nick change failed (this should be impossible)");
			return;
		}

		if (old_nick === undefined && conn.user !== undefined) {			// We just completed registration
			conn.welcome();
		}
	};

	handlers.handle_USER = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		if (user_is_legal(tokens[1]) === false) {
			return;
		}

		if (conn.user !== undefined) {										// Can't change user after it's set
			conn.numeric(462, ":You may not reregister");
			return;
		}

		conn.user = tokens[1];

		if (conn.nick !== undefined) {										// We just completed registration
			conn.welcome();
		}
	};

	handlers.handle_JOIN = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.join(chan_name);
	};

	handlers.handle_PART = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);

		if (chan_is_legal(chan_name) === false) {
			return;
		}

		conn.part(chan_name, false);
	};

	handlers.handle_PRIVMSG = (irc, conn, tokens) => {

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

	handlers.handle_WHOIS = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		let target = irc.conn_from_nick(tokens[1]);

		if (target === undefined) {
			conn.numeric(401, `${tokens[1]} :No such nick`);
			return;
		}

		target.whois_reply(conn);
	};

	handlers.handle_PING = (irc, conn, tokens) => {
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
