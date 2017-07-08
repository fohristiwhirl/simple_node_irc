import random
import socket
import time

random.seed()

serveraddr = '127.0.0.1'
serverport = 6667

s = None

# -----------------------------------------

letters = "abcdefghijklmnopqrstuvwxyz"

words = """area book business case child company country day eye fact family government group hand home job life
lot man money month mother night number part people place point problem program question right room school
state story student study system thing time water way week woman word work world year""".split()

# -----------------------------------------

def connect():
	global s
	s = socket.socket()
	s.connect((serveraddr, serverport))
	s.setblocking(False)
	change_nick()
	s.send("USER {}\n".format(generate_nick()).encode("ascii"))

def disconnect():
	global s
	s.close()

def reconnect():
	disconnect()
	connect()

# -----------------------------------------

def generate_nick():
	return "".join([random.choice(letters) for n in range(random.randint(5,8))])

def generate_sentence():
	return " ".join([random.choice(words) for n in range(random.randint(3,8))]) + random.choice([".", "?", "!"])

def choose_channel():
	return random.choice(["#test", "#TesT", "#foobar", "#FooBar"])

def change_nick():
	nick = generate_nick()
	s.send("NICK {}\n".format(nick).encode("ascii"))

def join_channel():
	channel = choose_channel()
	s.send("JOIN {}\n".format(channel).encode("ascii"))

def leave_channel():
	channel = choose_channel()
	s.send("PART {}\n".format(channel).encode("ascii"))

def send_message():
	channel = choose_channel()
	s.send("PRIVMSG {} :{}\n".format(channel, generate_sentence()).encode("ascii"))

# -----------------------------------------

all_acts = [change_nick, join_channel, leave_channel, send_message, reconnect]
last_act_time = time.time()
connect()

while True:
	if time.time() - last_act_time < 1:
		try:
			data = s.recv(1024)
			print(data.decode("ascii"))
		except BlockingIOError:
			time.sleep(0.1)
	else:
		random.choice(all_acts)()
		last_act_time = time.time()
