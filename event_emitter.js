/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS201: Simplify complex destructure assignments
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// EventEmitter with support for catch-all listeners and mixin
// TODO: Write tests

/*
* Usage

Extend EventEmitterModule class to use its features.

    EventEmitterModule = require './event_emitter'

    class MyClass extends EventEmitterModule

    obj = new MyClass
    obj.on 'testevent', (a, b, c) ->
      console.log "received testevent a=#{a} b=#{b} c=#{c}"

    obj.onAny (eventName, data...) ->
      console.log "received by onAny: eventName=#{eventName} data=#{data}"

    obj.emit 'testevent', 111, 222, 333
    obj.emit 'anotherevent', 'hello'

Alternatively, you can add EventEmitterModule features to
an existing class with `mixin`.

    class MyClass

    * Add EventEmitterModule features to MyClass
    EventEmitterModule.mixin MyClass

    obj = new MyClass
    obj.on 'testevent', ->
      console.log "received testevent"

    obj.emit 'testevent'

Also, EventEmitterModule can be injected dynamically into
an object, but with slightly worse performance.

    class MyClass
      constructor: ->
        EventEmitterModule.inject this

    obj = new MyClass
    obj.on 'testevent', ->
      console.log "received testevent"

    obj.emit 'testevent'
*/

class EventEmitterModule {
  // Apply EventEmitterModule to the class
  static mixin(cls) {
    const proto = EventEmitterModule.prototype;
    for (let name of Array.from(Object.getOwnPropertyNames(proto))) {
      if (name === 'constructor') {
        continue;
      }
      try {
        cls.prototype[name] = proto[name];
      } catch (e) {
        throw new Error("Call EventEmitterModule.mixin() after the class definition");
      }
    }
  }

  // Inject EventEmitterModule into the object
  static inject(obj) {
    const proto = EventEmitterModule.prototype;
    for (let name of Array.from(Object.getOwnPropertyNames(proto))) {
      if (name === 'constructor') {
        continue;
      }
      obj[name] = proto[name];
    }
    obj.eventListeners = {};
    obj.catchAllEventListeners = [];
  }

  emit(name, ...data) {
    let listener;
    if ((this.eventListeners != null ? this.eventListeners[name] : undefined) != null) {
      for (listener of Array.from(this.eventListeners[name])) {
        listener(...Array.from(data || []));
      }
    }
    if (this.catchAllEventListeners != null) {
      for (listener of Array.from(this.catchAllEventListeners)) {
        listener(name, ...Array.from(data));
      }
    }
  }

  onAny(listener) {
    if (this.catchAllEventListeners != null) {
      return this.catchAllEventListeners.push(listener);
    } else {
      return this.catchAllEventListeners = [ listener ];
    }
  }

  offAny(listener) {
    if (this.catchAllEventListeners != null) {
      for (let i = 0; i < this.catchAllEventListeners.length; i++) {
        const _listener = this.catchAllEventListeners[i];
        if (_listener === listener) {
          this.catchAllEventListeners.splice(i, i - i + 1, ...[].concat([]));  // remove element at index i
        }
      }
    }
  }

  on(name, listener) {
    if ((this.eventListeners == null)) {
      this.eventListeners = {};
    }
    if (this.eventListeners[name] != null) {
      return this.eventListeners[name].push(listener);
    } else {
      return this.eventListeners[name] = [ listener ];
    }
  }

  removeListener(name, listener) {
    if ((this.eventListeners != null ? this.eventListeners[name] : undefined) != null) {
      for (let i = 0; i < this.eventListeners[name].length; i++) {
        const _listener = this.eventListeners[name][i];
        if (_listener === listener) {
          this.eventListeners.splice(i, i - i + 1, ...[].concat([]));  // remove element at index i
        }
      }
    }
  }

  off(name, listener) {
    return this.removeListener(...arguments);
  }
}

module.exports = EventEmitterModule;
