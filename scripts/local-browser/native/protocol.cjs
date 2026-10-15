/** Raw, inert protocol controls. No socket/process exists until caller supplies it. */
function createFence(deadline, now = Date.now) {
  let failed = null,
    guard = false;
  return {
    admit() {
      if (failed) throw failed;
      if (now() >= deadline) {
        failed = Error('Operation deadline expired');
        throw failed;
      }
    },
    fail(reason) {
      failed ??= reason instanceof Error ? reason : Error(String(reason));
      return failed;
    },
    attestGuard() {
      this.admit();
      guard = true;
    },
    status() {
      return { failed: failed ? String(failed) : null, guardAttested: guard, deadline };
    },
  };
}
class InspectorProtocol {
  constructor(socket, fence, deadline) {
    this.socket = socket;
    this.fence = fence;
    this.deadline = deadline;
    this.pending = new Map();
    this.events = [];
    this.sequence = 0;
    this.intentional = false;
    this.lateAcknowledgements = 0;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        this.fail(error);
        return;
      }
      try {
        fence.admit();
      } catch (error) {
        this.lateAcknowledgements++;
        this.fail(error);
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.fail(Error('Unknown inspector acknowledgement'));
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(this.fail(Error(JSON.stringify(message.error))));
        } else pending.resolve(message.result);
      } else if (message.method) this.events.push(message);
    });
    socket.addEventListener('error', () => {
      if (!this.intentional) this.fail(Error('Inspector transport error'));
    });
    socket.addEventListener('close', () => {
      if (!this.intentional)
        this.fail(
          Error('Unexpected inspector disconnect; startup may resume but all proof work is revoked')
        );
    });
  }
  fail(error) {
    const failure = this.fence.fail(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    return failure;
  }
  request(method, params = {}) {
    this.fence.admit();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(Error('Inspector acknowledgement expired: ' + method)),
        Math.max(1, Math.min(3000, this.deadline - Date.now()))
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.fail(error);
      }
    }).then((result) => {
      this.fence.admit();
      return result;
    });
  }
  async close() {
    this.intentional = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('Inspector custody closing'));
    }
    this.pending.clear();
    this.socket.close();
  }
}
module.exports = { createFence, InspectorProtocol };
