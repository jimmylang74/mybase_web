import os
from flask import Flask
from flask_socketio import SocketIO

from modules.config import BASE_DIR


app = Flask(__name__,
    template_folder=str(BASE_DIR / 'web' / 'templates'),
    static_folder=str(BASE_DIR / 'web' / 'static'),
    static_url_path='/static')
app.config['SECRET_KEY'] = os.urandom(24).hex()

# Flask-SocketIO for real-time collaboration
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Register WebSocket handlers
from modules.websocket import register_handlers
register_handlers(socketio)

# Register HTTP routes
from modules.routes import register_routes
register_routes(app, socketio)
