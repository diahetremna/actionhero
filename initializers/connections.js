var uuid = require('node-uuid');

var connections = function(api, next){

  api.connections = {

    createCallbacks: [],
    destroyCallbacks: [],

    allowedVerbs: [
      'quit',
      'exit',
      'documentation',
      'paramAdd',
      'paramDelete',
      'paramView',
      'paramsView',
      'paramsDelete',
      'roomAdd',
      'roomLeave',
      'roomView',
      'detailsView',
      'say'
    ],

    connections: {},

    _start: function(api, next){
      next();
    },

    _stop: function(api, next){
      next();
    },

    apply: function(connectionId, method, args, callback){
      api.faye.doCluster('connection_apply', [connectionId, method, args], connectionId, callback);
    },

    applyCatch: function(connectionId, method, args, callback){
      var connection = api.connections.connections[connectionId];
      connection[method].call(connection, args);
      process.nextTick(function(){
        callback();
      });
    }

  };
  

  // {type: type, remotePort: remotePort, remoteIP: remoteIP, rawConnection: rawConnection}
  // id is optional and will be generated if missing
  api.connection = function(data){
    this.setup(data)
    api.stats.increment('connections:totalActiveConnections');
    api.stats.increment('connections:activeConnections:' + this.type);
    api.stats.increment('connections:totalConnections');
    api.stats.increment('connections:connections:' + this.type);
    api.connections.connections[this.id] = this;
    for(var i in api.connections.createCallbacks){
      api.connections.createCallbacks[i](this);
    }
  }

  api.connection.prototype.setup = function(data){
    var self = this;
    if(data.id != null){
      self.id = data.id;
    } else {
      self.id = self.generateID();
    }
    self.connectedAt = new Date().getTime();
    ['type', 'remotePort', 'remoteIP', 'rawConnection'].forEach(function(req){
      if(data[req] == null){ throw new Error(req + ' is required to create a new connection object') }
      self[req] = data[req];
    });

    var connectionDefaults = {
      error: null,
      rooms: [],
      params: {},
      response: {},
      pendingActions: 0,
      totalActions: 0,
      messageCount: 0,
      canChat: false
    }

    for(var i in connectionDefaults){
      self[i] = connectionDefaults[i];
    }
  }

  api.connection.prototype.generateID = function(){
    return uuid.v4();
  }

  api.connection.prototype.sendMessage = function(message){
    throw new Error('I should be replaced with a connection-specific method');
  }

  api.connection.prototype.sendFile = function(path){
    throw new Error('I should be replaced with a connection-specific method');
  }

  api.connection.prototype.destroy = function(callback){
    var self = this;
    self.destroyed = true;
    for(var i in api.connections.destroyCallbacks){
      api.connections.destroyCallbacks[i](self);
    }

    api.stats.increment('connections:totalActiveConnections', -1);
    api.stats.increment('connections:activeConnections:' + self.type, -1);
    if(self.canChat === true){ 
      self.rooms.forEach(function(room){
        api.chatRoom.removeMember(self.id, room); 
      });
    }
    delete api.connections.connections[self.id];
    var server = api.servers.servers[self.type];
    if(server.attributes.logExits === true){
      server.log('connection closed', 'info', {to: self.remoteIP});
    }
    if(typeof server.goodbye === 'function'){ server.goodbye(self); }
    if(typeof callback == 'function'){ callback() }
  }

  api.connection.prototype.set = function(key, vale){
    var self = this;
    self[key] = value;
  }

  api.connection.prototype.verbs = function(verb, words, callback){
    var self = this;
    var key,value,room;
    var server = api.servers.servers[self.type];
    var allowedVerbs = server.attributes.verbs;
    if(typeof words === 'function' && callback == null){
      callback = words;
      words = [];
    }
    if(!(words instanceof Array)){
      words = [words];
    }
    if(allowedVerbs.indexOf(verb) >= 0){
      server.log('verb', 'debug', {verb: verb, to: self.remoteIP, params: JSON.stringify(words)});
      if(verb === 'quit' || verb === 'exit'){
        server.goodbye(self);

      } else if(verb === 'paramAdd'){
        key = words[0];
        value = words[1];
        if(words[0].indexOf('=') >= 0){
          var parts = words[0].split('=');
          key = parts[0];
          value = parts[1];
        }
        if(api.config.general.disableParamScrubbing || api.params.postVariables.indexOf(key) > 0){
          self.params[key] = value;
        }
        if(typeof callback === 'function'){ callback(null, null); }
      } else if(verb === 'paramDelete'){
        var key = words[0];
        delete self.params[key];
        if(typeof callback === 'function'){ callback(null, null); }

      } else if(verb === 'paramView'){
        var key = words[0];
        if(typeof callback === 'function'){ callback(null, self.params[key]); }

      } else if(verb === 'paramsView'){
        if(typeof callback === 'function'){ callback(null, self.params); }

      } else if(verb === 'paramsDelete'){
        for(var i in self.params){
          delete self.params[i];
        }
        if(typeof callback === 'function'){ callback(null, null); }

      } else if(verb === 'roomAdd'){
        var room = words[0];
        api.chatRoom.addMember(self.id, room, function(err, didHappen){
          if(typeof callback === 'function'){ callback(err, didHappen); }
        });

      } else if(verb === 'roomLeave'){
        var room = words[0];
        api.chatRoom.removeMember(self.id, room, function(err, didHappen){
          if(typeof callback === 'function'){ callback(err, didHappen); }
        });

      } else if(verb === 'roomView'){
        var room = words[0];
        if(self.rooms.indexOf(room) > -1){
          api.chatRoom.roomStatus(room, function(err, roomStatus){
            if(typeof callback === 'function'){ callback(err, roomStatus); }
          });
        }else{
          if(typeof callback === 'function'){ callback('not member of room ' + room); }
        }

      } else if(verb === 'detailsView'){
        var details = {}
        details.id = self.id;
        details.remoteIP = self.remoteIP;
        details.remotePort = self.remotePort;
        details.params = self.params;
        details.connectedAt = self.connectedAt;
        details.rooms = self.rooms;
        details.totalActions = self.totalActions;
        details.pendingActions = self.pendingActions;
        if(typeof callback === 'function'){ callback(null, details); }

      } else if(verb === 'documentation'){
        if(typeof callback === 'function'){ callback(null, api.documentation.documentation); }

      } else if(verb === 'say'){
        var room = words.shift();
        api.chatRoom.broadcast(self, room, words.join(' '), function(err){
          if(typeof callback === 'function'){ callback(err); }
        });

      } else {
        if(typeof callback === 'function'){ callback('I do not know know to perform this verb', null); }
      }
    } else {
      if(typeof callback === 'function'){ callback('verb not found or not allowed', null); }
    }
  }

  next();
}

exports.connections = connections;
