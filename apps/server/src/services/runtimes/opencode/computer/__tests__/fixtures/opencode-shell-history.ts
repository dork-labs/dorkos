/** Sanitized actual pinned OpenCode1.19 guest SDK shell response, 2026-10-13. */
export const shellHistory = [
  {
    info: {
      id: 'msg_user',
      sessionID: 'ses_fixture',
      role: 'user',
      time: {
        created: 1000,
      },
      agent: 'build',
      model: {
        providerID: 'qualification',
        modelID: 'no-inference',
      },
    },
    parts: [
      {
        id: 'prt_user',
        sessionID: 'ses_fixture',
        messageID: 'msg_user',
        type: 'text',
        text: 'The following tool was executed by the user',
        synthetic: true,
      },
    ],
  },
  {
    info: {
      id: 'msg_assistant',
      sessionID: 'ses_fixture',
      role: 'assistant',
      time: {
        created: 1000,
        completed: 1001,
      },
      parentID: 'msg_user',
      modelID: 'no-inference',
      providerID: 'qualification',
      mode: 'build',
      agent: 'build',
      path: {
        cwd: '/home/agent/project',
        root: '/',
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts: [
      {
        id: 'prt_assistant',
        sessionID: 'ses_fixture',
        messageID: 'msg_assistant',
        type: 'tool',
        callID: 'call_fixture',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {
            command: "printf 'qualification-marker\\n'; pwd; uname -s",
          },
          output: 'qualification-marker\n/home/agent/project\nLinux\n',
          title: '',
          metadata: {
            output: 'qualification-marker\n/home/agent/project\nLinux\n',
          },
          time: {
            start: 1000,
            end: 1001,
          },
        },
      },
    ],
  },
];
