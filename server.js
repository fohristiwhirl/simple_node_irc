"use strict";

const net = require("net");

const SERVER = "127.0.0.1";
const PORT = 6667;

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
	bit of refactoring since the closures need to be eliminated.
	Also, there probably aren't worthwhile performance benefits.
*/

const SOFTWARE = "Simple Node IRC";

const MAX_USERS_PER_CHANNEL = 50;
const MAX_USERS_PER_SERVER = 500;
const MAX_CHANNELS_PER_USER = 10;

const MAX_NAME_LENGTH = 30;

const LOG_INPUTS = true;
const LOG_EVENTS = true;

const STARTUP_TIME = (new Date()).toTimeString();

// ---------------------------------------------------------------------------------------------------

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
	return str.length > 0 && str.length <= MAX_NAME_LENGTH && is_alphanumeric(str);
}

function user_is_legal(str) {
	return str.length > 0 && str.length <= MAX_NAME_LENGTH && is_alphanumeric(str);
}

function chan_is_legal(str) {
	if (str.charAt(0) !== "#") {
		return false;
	}
	if (str.length > 1 && str.length <= MAX_NAME_LENGTH && is_alphanumeric(str.slice(1))) {
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

function log_event(msg) {
	if (LOG_EVENTS) {
		console.log("\n-- " + msg);
	}
}

function log_input(conn, msg) {
	if (LOG_INPUTS && msg.trim() !== "") {
		console.log("\n" + conn.source() + `  (${conn.port})` + "\n   " + msg);
	}
}

// ---------------------------------------------------------------------------------------------------

function make_irc_server() {

	// The canonical list of who is connected and what channels exist.

	let irc = {
		conns:		Object.create(null),	// map: nick --> conn object
		channels:	Object.create(null),	// map: chan_name --> channel object
		user_count:	0,						// this is all users, registered OR NOT
		next_id:	0,
	};

	irc.new_id = () => {
		return irc.next_id++;
	};

	irc.full = () => {
		return irc.user_count >= MAX_USERS_PER_SERVER;
	};

	irc.note_new_connection = () => {		// Keep track of any and all connections
		irc.user_count += 1;
	};

	irc.nick_in_use = (nick) => {
		if (irc.conns[nick.toLowerCase()] !== undefined) {
			return true;
		}
		return false;
	};

	irc.conn_from_nick = (nick) => {
		return irc.conns[nick.toLowerCase()];		// Can return undefined
	};

	irc.disconnect = (conn, reason) => {

		// Our count of users includes clients that didn't finish registering...

		irc.user_count -= 1;

		// But if they are not in our map of users, we can just return...

		if (conn === undefined || irc.conns[conn.nick.toLowerCase()] === undefined) {
			log_event(`Unregistered user ${conn.address}:${conn.port} disconnected`);
			return;
		}

		// Note that clients that have set their NICK but did not set their USER will
		// be allowed past this phase. Such nicks do need to be removed from the map.

		log_event(`User ${conn.nick} is disconnecting`);

		reason = reason || "";

		let all_viewers = conn.viewer_list();

		conn.part_all_channels(true);		// Do this AFTER getting the viewer list

		all_viewers.forEach((out_conn) => {
			out_conn.write(`:${conn.source()} QUIT :${reason}` + "\r\n");
		});

		delete irc.conns[conn.nick.toLowerCase()];
	};

	irc.add_conn = (conn) => {				// Should be called once per client, exactly when conn.nick is set
		irc.conns[conn.nick.toLowerCase()] = conn;
	};

	irc.change_nick = (conn, old_nick, new_nick) => {

		if (irc.nick_in_use(new_nick)) {
			conn.numeric(433, ":Nickname is already in use");
			return;
		}

		if (nick_is_legal(new_nick) === false) {
			conn.numeric(432, ":Erroneus nickname");
			return;
		}

		// Tell everyone who can see the user about this...

		let all_recipients = (conn.nick === undefined) ? [] : conn.viewer_list();

		all_recipients.forEach((out_conn) => {
			out_conn.write(`:${conn.source()} NICK ${new_nick}` + "\r\n");		// Note that conn hasn't been updated yet so conn.source() correctly gives the old source.
		});

		// We set the nick in the conn object ourselves... (slightly icky)...

		conn.nick = new_nick;

		irc.conns[new_nick.toLowerCase()] = conn;

		if (old_nick === undefined) {
			irc.add_conn(conn);				// irc.add_conn() should be called the moment a conn gets its first nick, regardless of whether registration is complete.
		} else {
			delete irc.conns[old_nick.toLowerCase()];
		}
	};

	irc.get_channel = (chan_name) => {
		return irc.channels[chan_name.toLowerCase()];		// Can return undefined
	}

	irc.get_or_make_channel = (chan_name) => {

		if (chan_is_legal(chan_name) === false) {
			return undefined;
		}

		// The channel name is allowed to have uppercase characters, but we store it in our map as lowercase.

		if (irc.channels[chan_name.toLowerCase()] === undefined) {
			irc.channels[chan_name.toLowerCase()] = make_channel(chan_name, () => irc.close_channel(chan_name));
			log_event(`Creating channel ${chan_name}`);
		}

		return irc.channels[chan_name.toLowerCase()];
	};

	irc.close_channel = (chan_name) => {
		delete irc.channels[chan_name.toLowerCase()];
		log_event(`Closing channel ${chan_name}`);
	};

	irc.isupport = (conn) => {

		const parts = {
			CASEMAPPING:	"ascii",
			CHANTYPES:		"#",
			MAXCHANNELS:	MAX_CHANNELS_PER_USER,
			NICKLEN:		MAX_NAME_LENGTH,
			CHANNELLEN:		MAX_NAME_LENGTH,
		};

		let msg = Object.keys(parts).map(key => `${key}=${parts[key]}`).join(" ");

		conn.numeric(5, msg + " :are supported by this server");
	}

	return irc;
}

// ---------------------------------------------------------------------------------------------------

function make_channel(chan_name, close_function) {

	// Channels aren't notified if a user's nick changes,
	// so the keys to the conn map have to be a uid.

	let channel = {
		conns:			Object.create(null),		// map: uid --> conn
		user_count:		0,
		name:			chan_name,
		close_function:	close_function,
	};

	channel.conn_list = () => {
		return Object.keys(channel.conns).map(uid => channel.conns[uid]);
	};

	channel.nick_list = () => {
		return Object.keys(channel.conns).map(uid => channel.conns[uid].nick);
	};

	channel.full = () => {
		return channel.user_count >= MAX_USERS_PER_CHANNEL;
	};

	channel.user_present = (conn) => {
		return channel.conns[conn.uid] !== undefined;
	};

	channel.add_conn = (conn) => {

		// Returns true or false: whether the connection was allowed...
		// The calling conn then needs to update its own record of what channels it is in, accordingly.

		if (channel.user_present(conn)) {
			return false;
		}

		if (channel.full()) {
			conn.numeric(471, `${chan_name} :Channel is full`);
			return false;
		}

		channel.conns[conn.uid] = conn;
		channel.user_count += 1;

		channel.raw_send_all(`:${conn.source()} JOIN ${channel.name}`);

		return true;
	};

	channel.remove_conn = (conn, silent) => {

		if (channel.user_present(conn) === false) {
			return;
		}

		if (silent === false || silent === undefined) {
			channel.raw_send_all(`:${conn.source()} PART ${channel.name}`);
		}

		delete channel.conns[conn.uid];
		channel.user_count -= 1;

		if (channel.user_count === 0) {
			channel.close_function();
		}
	};

	channel.raw_send_all = (msg) => {
		channel.conn_list().forEach((conn) => {
			conn.write(msg + "\r\n");
		});
	};

	channel.normal_message = (conn, msg) => {

		msg = msg.trim();

		if (msg.length < 1) {
			return;
		}

		if (channel.conns[conn.uid] === undefined) {			// User is not in the channel
			conn.numeric(404, ":Cannot send to channel");
			return;
		}

		let source = conn.source();

		channel.conn_list().forEach((out_conn) => {
			if (conn !== out_conn) {
				out_conn.write(`:${source} PRIVMSG ${channel.name} :${msg}` + "\r\n");
			}
		});
	};

	channel.name_reply = (conn) => {
		conn.numeric(353, `= ${channel.name} :` + channel.nick_list().join(" "));
		conn.numeric(366, `${channel.name} :End of /NAMES list`);
	};

	channel.topic_reply = (conn) => {
		conn.numeric(331, `${channel.name} :No topic is set`);
	};

	return channel;
}

// ---------------------------------------------------------------------------------------------------

function new_connection(irc_object, handlers_object, socket) {

	let conn = {
		nick:		undefined,
		user:		undefined,
		irc:		irc_object,					// a reference to the irc object (i.e. main state holder)
		handlers:	handlers_object,			// handlers for commands e.g. JOIN, NICK etc
		socket:		socket,
		address:	socket.remoteAddress,		// good to cache address and port I think
		port:		socket.remotePort,
		uid:		-1,
		channels:	Object.create(null),		// map: chan_name --> channel object
		last_act:	Date.now(),
	};

	if (conn.irc.full()) {
		log_event(`New connection REFUSED: ${conn.address}:${conn.port} (server full)`);
		socket.write(`:${SERVER} :Server is full` + "\r\n");
		socket.destroy();
		return;
	}

	conn.uid = conn.irc.new_id();
	conn.irc.note_new_connection();				// This just increments a counter

	log_event(`New connection: ${conn.address}:${conn.port}`);

	// Setup socket actions...

	socket.on("data", (data) => {
		let lines = data.toString().split("\n");
		lines.forEach((line) => {
			conn.handle_line(line);
		});
	});

	socket.on("close", () => {
		conn.irc.disconnect(conn, undefined);	// this will call conn.part_all_channels()
	});

	socket.on("error", () => {
		return;
	});

	// Conn methods...

	conn.source = () => {
		return `${conn.nick}!${conn.user}@${conn.address}`;
	};

	conn.channel_name_list = () => {
		return Object.keys(conn.channels);
	};

	conn.channel_list = () => {
		return Object.keys(conn.channels).map(name => conn.channels[name]);
	};

	conn.channel_count = () => {
		return Object.keys(conn.channels).length;
	}

	conn.viewer_list = () => {					// Return a list of conns that can see this client (i.e. in channels).

		let all_viewers = Object.create(null);	// Using this as a map so that things can only be in it once: nick --> conn

		all_viewers[conn.nick] = conn;			// Always include self.

		conn.channel_list().forEach((channel) => {
			channel.conn_list().forEach((other_conn) => {
				all_viewers[other_conn.nick] = other_conn;
			});
		});

		return Object.keys(all_viewers).map(nick => all_viewers[nick]);
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

		chan_name = sanitize_channel_name(chan_name);

		// Channel names can contain uppercase chars, but we store them as lowercase in the conn object.

		if (conn.channels[chan_name.toLowerCase()] !== undefined) {		// We're already in this channel
			return;
		}

		if (conn.channel_count() >= MAX_CHANNELS_PER_USER) {
			conn.numeric(405, ":You have joined too many channels");
			return;
		}

		let channel = conn.irc.get_or_make_channel(chan_name);

		if (channel === undefined) {
			conn.numeric(403, ":Illegal channel name");
			return;
		}

		let success = channel.add_conn(conn);

		if (success !== true) {
			return;
		}

		conn.channels[chan_name.toLowerCase()] = channel;

		channel.name_reply(conn);							// Send a RPL_NAMREPLY to the client (list of users in channel)
		channel.topic_reply(conn);							// Send a RPL_NOTOPIC or RPL_TOPIC to the client
	};

	conn.part = (chan_name, silent) => {

		chan_name = sanitize_channel_name(chan_name);		// No need to check for legality of channel name
		let channel = conn.irc.get_channel(chan_name);

		if (channel === undefined) {
			return;
		}

		channel.remove_conn(conn, silent);
		delete conn.channels[chan_name.toLowerCase()];
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
		conn.irc.isupport(conn);
		log_event(`${conn.nick} finished registering`);
	};

	conn.whois_reply = (requester) => {

		// Reply to a WHOIS about this client.
		// FIXME: there's some more stuff we're supposed to send...

		let idle_time = Math.floor((Date.now() - conn.last_act) / 1000);

		requester.numeric(311, `${conn.nick} ${conn.user} ${conn.address} * :${conn.user}`);
		requester.numeric(317, `${conn.nick} ${idle_time} :seconds idle`);
		requester.numeric(318, `${conn.nick} :End of /WHOIS list`);
	};

	conn.handle_line = (msg) => {

		log_input(conn, msg);
		conn.last_act = Date.now();

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

		let handler = conn.handlers["handle_" + tokens[0]];

		if (typeof(handler) !== "function") {
			conn.numeric(421, `${tokens[0]} :Unknown command`);
			return;
		}

		handler(conn.irc, conn, tokens);
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
		let old_nick = conn.nick;

		irc.change_nick(conn, old_nick, requested_nick);

		// If all went well, conn.nick was just set to requested_nick, otherwise, bail out...

		if (conn.nick !== requested_nick) {
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

		conn.join(tokens[1]);
	};

	handlers.handle_PART = (irc, conn, tokens) => {

		if (tokens.length < 2) {
			return;
		}

		conn.part(tokens[1], false);
	};

	handlers.handle_PRIVMSG = (irc, conn, tokens) => {

		if (tokens.length < 3) {
			return;
		}

		let chan_name = sanitize_channel_name(tokens[1]);
		let channel = irc.get_channel(chan_name);

		if (channel === undefined) {
			conn.numeric(403, ":No such channel");
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

	process.on('uncaughtException', (err) => {
		console.log("\n\n\n");
		console.error(err);
		console.log("\n\n\n");
		process.stderr.write("\x07");	// Beep
	});

	let irc = make_irc_server();
	let handlers = make_handlers();

	let server = net.createServer((socket) => {
		new_connection(irc, handlers, socket);
	});

	server.listen(PORT, SERVER);

	log_event(`Server startup at ${STARTUP_TIME}`);
}

// ---------------------------------------------------------------------------------------------------

main();
