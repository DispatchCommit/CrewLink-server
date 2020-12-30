import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import socketIO from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';

const supportedCrewLinkVersions = new Set(['1.2.0']);
const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');

const sslCertificatePath = process.env.SSLPATH || process.cwd();

const logger = Tracer.colorConsole({
	format: "{{timestamp}} <{{title}}> {{message}}"
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer({
		key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
		cert: readFileSync(join(sslCertificatePath, 'fullchain.pem'))
	}, app);
} else {
	server = new Server(app);
}
const io = socketIO(server);

const clients = new Map<string, Client>();

interface Client {
	playerId: number;
	clientId: number;
}

interface Signal {
	data: string;
	to: string;
}

app.set('view engine', 'pug')
app.use(morgan('combined'))

let connectionCount = 0;
let address = process.env.ADDRESS || 'vc.dispatchplays.tv';
if (!address) {
	logger.error('You must set the ADDRESS environment variable.');
	process.exit(1);
}

app.get('/', (_, res) => {
	res.render('index', { connectionCount, address });
});

app.get('/health', (req, res) => {
	res.json({
		uptime: process.uptime(),
		connectionCount,
		address,
		name: process.env.NAME
	});
});

// API
app.get('/v1/lobby/:lobby', (req, res) => {
  const lobbyParam = req.params.lobby;
  if ( lobbyParam && typeof lobbyParam === 'string' && lobbyParam.length === 6 ) {
    let allClients: any = {};
    let socketsInLobby = Object.keys(io.sockets.adapter.rooms[lobbyParam].sockets);
    for (let s of socketsInLobby) {
      if ( clients.has(s) ) {
        allClients[s] = clients.get(s);
      }
    }

    res.json({
      lobby: lobbyParam,
      playerCount: socketsInLobby.length,
      clients: allClients,
    });
  }
});

//-------------------------
// Middleware Version Check
io.use((socket, next) => {
	const userAgent = socket.request.headers['user-agent'];
	const matches = /^(?:CrewLink|DispatchLink)\/(\d+\.\d+\.\d+) \((\w+)\)$/.exec(userAgent);
	const error = new Error() as any;
	error.data = { message: 'The voice server does not support your version of DispatchLink.\nSupported versions: ' + Array.from(supportedCrewLinkVersions).join() };

	console.log( `Client connected running v${matches[1]}` );

	// disable client version check
	return next();

	if (!matches) {
		next(error);
	} else {
		const version = matches[1];
		// const platform = matches[2];
		if (supportedCrewLinkVersions.has(version)) {
			next();
		} else {
			next(error);
		}
	}
});


io.on('connection', (socket: socketIO.Socket) => {
	connectionCount++;
	logger.info("Total connected: %d", connectionCount);
	let code: string | null = null;


	//-------------
	// Player Joins
	socket.on('join', (lobbyCode: string, playerId: number, clientId: number) => {
		if (
		  typeof lobbyCode !== 'string' ||
      typeof playerId !== 'number' ||
      typeof clientId !== 'number'
    ) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %d %d`, socket.id, lobbyCode, playerId, clientId);
			return;
		}

		let otherClients: any = {};
		if (io.sockets.adapter.rooms[lobbyCode]) {
			let socketsInLobby = Object.keys(io.sockets.adapter.rooms[lobbyCode].sockets);
			for (let s of socketsInLobby) {
				if (
				  clients.has(s) &&
          clients.get(s).clientId === clientId
        ) {
					socket.disconnect();
					logger.error(`Socket %s sent invalid join command, attempted spoofing another client`);
					return;
				}
				if (s !== socket.id)
					otherClients[s] = clients.get(s);
			}
		}

		code = lobbyCode;

		socket.join(code);

		const client = {
      playerId: playerId,
      clientId: clientId === Math.pow(2, 32) - 1 ? null : clientId
    };

		// Alert other clients of new user
    clients.set(socket.id, client);
		socket.to(code).broadcast.emit('join', socket.id, client);

		// Send client list to joining user
		socket.emit('setClients', otherClients);

		logger.info( `[JOIN] lobbyCode: ${lobbyCode} playerId: ${playerId} clientId: ${clientId}` );
	});


	//------------------
	// Player Id Changed
	socket.on('id', (id: number, clientId: number) => {
		if (
		  typeof id !== 'number' ||
      typeof clientId !== 'number'
    ) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command: %d %d`, socket.id, id, clientId);
			return;
		}

		let client = clients.get(socket.id);
		if (
		  client != null &&
      client.clientId != null &&
      client.clientId !== clientId
    ) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command, attempted spoofing another client`);
			return;
		}

		client = {
			playerId: id,
			clientId: clientId === Math.pow(2, 32) - 1 ? null : clientId
		};
		clients.set(socket.id, client);
		socket.to(code).broadcast.emit('setClient', socket.id, client);

		logger.info( `[ID] Lobby: ${code} Client:`, client );
	});


	//------------
  // Player Left
	socket.on('leave', () => {
		if (code) {
		  logger.info( `[LEAVE] Socket.id:`, socket.id );

		  if ( clients.has(socket.id) ) {
        let client = clients.get(socket.id);
        logger.info( `[LEAVE] Client:`, client );
        logger.info( `[LEAVE] lobbyCode: ${code} playerId: ${client?.playerId} clientId: ${client?.clientId}` );
      }

			socket.leave(code);
      clients.delete(socket.id);

      code = null;
		}
	});


	//-------------
  // Signal Relay
	socket.on('signal', (signal: Signal) => {
		if (
		  typeof signal !== 'object' ||
      !signal.data ||
      !signal.to ||
      typeof signal.to !== 'string'
    ) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		io.to(to).emit('signal', {
			data,
			from: socket.id
		});
	});


	//--------------------
	// Client Disconnected
	socket.on('disconnect', () => {
		clients.delete(socket.id);
		connectionCount--;
		logger.info("Total connected: %d", connectionCount);
	});

})

// Start server
server.listen(port);

(async () => {
	logger.info('DispatchLink Server started: %s', address);
})();
