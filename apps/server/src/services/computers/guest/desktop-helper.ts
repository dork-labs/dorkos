/** Root-owned desktop bridge. Agent MCP and person authority use separate credentials. */
export const DESKTOP_HELPER = String.raw`import base64, hmac, json, os, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

with open('/etc/dorkos-computer/desktop-token') as f: HOST_TOKEN=f.read().strip()
with open('/etc/dorkos-computer/agent-token') as f: AGENT_TOKEN=f.read().strip()
lock=threading.Lock()
lease=None
generation=0
lease_deadline=0.0
held=set()

def command(args):
    return subprocess.run(['/usr/sbin/runuser','-u','desktop','--','/usr/bin/env','DISPLAY=:0','HOME=/home/desktop','XAUTHORITY=/home/desktop/.Xauthority']+args,
      capture_output=True, timeout=8, check=True).stdout

def release():
    for key in list(held):
        command(['/usr/bin/xdotool','mouseup',key[6:]]) if key.startswith('mouse:') else command(['/usr/bin/xdotool','keyup',key])
    held.clear()

def frame():
    data=command(['/usr/bin/import','-window','root','png:-'])
    if len(data)>5000000: raise ValueError('Frame exceeds limit')
    return data

def input_event(body,person=False):
    kind=body.get('kind',body.get('type'))
    action=body.get('action')
    if kind=='pointer':
        x,y=body.get('x'),body.get('y')
        if type(x)!=int or type(y)!=int or not 0<=x<1280 or not 0<=y<800: raise ValueError('Invalid coordinates')
        command(['/usr/bin/xdotool','mousemove',str(x),str(y)])
        if action in ('down','up'):
            button=body.get('button',0 if person else 1)
            if person:
                if type(button)!=int or not 0<=button<=2: raise ValueError('Invalid button')
                button+=1
            if type(button)!=int or not 1<=button<=5: raise ValueError('Invalid button')
            command(['/usr/bin/xdotool','mousedown' if action=='down' else 'mouseup',str(button)])
            marker='mouse:'+str(button)
            if action=='down': held.add(marker)
            else: held.discard(marker)
        elif action not in (None,'move'): raise ValueError('Invalid pointer action')
    elif kind=='text':
        text=body.get('text')
        if not isinstance(text,str) or len(text)>4096 or chr(0) in text: raise ValueError('Invalid text')
        command(['/usr/bin/xdotool','type','--clearmodifiers','--',text])
    elif kind=='key':
        key=body.get('key')
        aliases={'Enter':'Return',' ':'space','ArrowLeft':'Left','ArrowRight':'Right','ArrowUp':'Up','ArrowDown':'Down','Backspace':'BackSpace','Control':'Control_L','Alt':'Alt_L','Shift':'Shift_L','Meta':'Super_L','PageUp':'Page_Up','PageDown':'Page_Down', '@':'at','.':'period','/':'slash','=':'equal',':':'colon',';':'semicolon',',':'comma','?':'question','!':'exclam','-':'minus','_':'underscore','+':'plus','(':'parenleft',')':'parenright','[':'bracketleft',']':'bracketright','{':'braceleft','}':'braceright', '#':'numbersign','$':'dollar','%':'percent','^':'asciicircum','&':'ampersand','*':'asterisk','~':'asciitilde',chr(96):'grave', chr(39):'apostrophe',chr(34):'quotedbl',chr(92):'backslash','|':'bar','<':'less','>':'greater'}
        key=aliases.get(key,key)
        allowed={'Return','Escape','Tab','BackSpace','Delete','Left','Right','Up','Down','Home','End','Page_Up','Page_Down','space','Control_L','Alt_L','Shift_L','Super_L','ctrl+l','ctrl+c','ctrl+v','ctrl+a','alt+F4'}
        if not isinstance(key,str) or (key not in allowed and key not in aliases.values() and not (len(key)==1 and key.isascii() and key.isalnum())): raise ValueError('Invalid key')
        if action in ('down','up'):
            command(['/usr/bin/xdotool','keydown' if action=='down' else 'keyup',key])
            if action=='down': held.add(key)
            else: held.discard(key)
        elif action is None: command(['/usr/bin/xdotool','key','--clearmodifiers',key])
        else: raise ValueError('Invalid key action')
    else: raise ValueError('Invalid input')

TOOLS=[{'name':'computer_screenshot','description':'See the same visible computer desktop as the person.','inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
 {'name':'computer_input','description':'Use the visible desktop. Refused while a person has control.','inputSchema':{'type':'object','properties':{'kind':{'enum':['pointer','text','key']},'action':{'enum':['move','down','up']},'x':{'type':'integer'},'y':{'type':'integer'},'button':{'type':'integer'},'text':{'type':'string'},'key':{'type':'string'}},'required':['kind'],'additionalProperties':False}}]

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def authorized(self,token):
        return hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+token)
    def respond(self,code,value,kind='application/json'):
        data=value if isinstance(value,bytes) else json.dumps(value).encode()
        self.send_response(code); self.send_header('Content-Type',kind); self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if not self.authorized(HOST_TOKEN): return self.respond(401,{'error':'Unauthorized'})
        try:
            if self.path=='/health':
                command(['/usr/bin/xdotool','getdisplaygeometry'])
                subprocess.run(['/usr/bin/systemctl','is-active','--quiet','dorkos-chromium.service'],check=True,timeout=5,capture_output=True)
                return self.respond(200,{'ready':True})
            if self.path=='/frame':
                with lock: data=frame()
                return self.respond(200,{'dataUrl':'data:image/png;base64,'+base64.b64encode(data).decode(),'width':1280,'height':800})
            self.respond(404,{'error':'Unknown operation'})
        except Exception: self.respond(503,{'error':'Desktop unavailable'})
    def do_POST(self):
        global lease, generation, lease_deadline
        is_host=self.authorized(HOST_TOKEN)
        is_agent=self.authorized(AGENT_TOKEN)
        if not is_host and not (is_agent and self.path=='/mcp'): return self.respond(401,{'error':'Unauthorized'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=16384: return self.respond(413,{'error':'Body limit exceeded'})
            body=json.loads(self.rfile.read(length))
            with lock:
                if self.path=='/control' and is_host:
                    value=body.get('leaseId') if body.get('held') else None
                    requested=body.get('generation')
                    if body.get('renew') or (value is not None and value==lease and requested==generation):
                        if lease is None or requested!=generation or value!=lease: return self.respond(409,{'error':'Control lease expired'})
                        lease_deadline=time.monotonic()+30.0
                        return self.respond(200,{'controlled':True})
                    if not body.get('held') and lease is not None and body.get('leaseId')!=lease: return self.respond(409,{'error':'Control lease expired'})
                    if type(requested)!=int or requested<generation: return self.respond(409,{'error':'Stale generation'})
                    generation=requested
                    if value is not None and (not isinstance(value,str) or not 16<=len(value)<=128): raise ValueError('Invalid lease')
                    release(); lease=value
                    lease_deadline=time.monotonic()+30.0 if value else 0.0
                    subprocess.run(['/usr/bin/systemctl','freeze' if value else 'thaw','dorkos-opencode.service'],check=True,timeout=5,capture_output=True)
                    return self.respond(200,{'controlled':lease is not None})
                if self.path=='/input' and is_host:
                    if body.get('generation')!=generation or lease is None or not hmac.compare_digest(body.get('leaseId',''),lease): return self.respond(409,{'error':'Control lease expired'})
                    input_event(body,person=True); return self.respond(200,{'ok':True})
                if self.path=='/sign-in' and is_host:
                    subprocess.Popen(['/usr/sbin/runuser','-u','desktop','--','/usr/bin/env','DISPLAY=:0','HOME=/home/desktop','XAUTHORITY=/home/desktop/.Xauthority','/usr/bin/xterm','-title','Sign in to OpenCode','-e','/usr/bin/sudo','-n','/usr/local/sbin/dorkos-vendor-login'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    return self.respond(200,{'ok':True})
                if self.path=='/mcp': return self.mcp(body)
            self.respond(404,{'error':'Unknown operation'})
        except Exception: self.respond(400,{'error':'Computer operation failed'})
    def mcp(self,body):
        method=body.get('method'); params=body.get('params',{}); result={}
        if method=='notifications/initialized': return self.respond(202,b'')
        if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'dorkos-computer','version':'1.0.0'}}
        elif method=='tools/list': result={'tools':TOOLS}
        elif method=='tools/call':
            name=params.get('name')
            if name=='computer_screenshot': result={'content':[{'type':'image','data':base64.b64encode(frame()).decode(),'mimeType':'image/png'}]}
            elif name=='computer_input':
                if lease is not None: result={'isError':True,'content':[{'type':'text','text':'A person has control. Wait until they return control.'}]}
                else:
                    input_event(params.get('arguments',{})); result={'content':[{'type':'text','text':'Input delivered.'}]}
            else: raise ValueError('Unknown tool')
        elif method=='ping': result={}
        else: return self.respond(200,{'jsonrpc':'2.0','id':body.get('id'),'error':{'code':-32601,'message':'Unknown method'}})
        self.respond(200,{'jsonrpc':'2.0','id':body.get('id'),'result':result})

def expire_once(now):
    global lease, lease_deadline
    if lease is not None and now>=lease_deadline:
        release()
        subprocess.run(['/usr/bin/systemctl','thaw','dorkos-opencode.service'],check=True,timeout=5,capture_output=True)
        lease=None; lease_deadline=0.0

def expire_control():
    while True:
        time.sleep(1)
        with lock:
            try: expire_once(time.monotonic())
            except Exception: pass

threading.Thread(target=expire_control,daemon=True).start()
ThreadingHTTPServer(('127.0.0.1',6080),Handler).serve_forever()
`;
