import random
import socket
import time

random.seed()

serveraddr = '127.0.0.1'
serverport = 6667

letters = "abcdefghijklmnopqrstuvwxyz"

words = """area book business case child company country day eye fact family government group hand home job life
lot man money month mother night number part people place point problem program question right room school
state story student study system thing time water way week woman word work world year""".split()

nick = "".join([random.choice(letters) for n in range(random.randint(5,8))])

s = socket.socket()
s.connect((serveraddr, serverport))
s.setblocking(False)

s.send("NICK {}\n".format(nick).encode("ascii"))
s.send("USER {}\n".format(nick).encode("ascii"))
s.send("JOIN #test\n".encode("ascii"))

last_msg_time = time.time();

while True:
	if time.time() - last_msg_time > 5:
		msg = " ".join([random.choice(words) for n in range(random.randint(3,8))]) + random.choice([".", "?", "!"]);
		s.send("PRIVMSG #test :{}\n".format(msg).encode("ascii"))
		last_msg_time = time.time();
	try:
		data = s.recv(1024)
		print(data.decode("ascii"))
	except BlockingIOError:
		time.sleep(0.1)

s.close()
