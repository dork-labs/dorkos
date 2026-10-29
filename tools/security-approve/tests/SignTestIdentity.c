// Test-only signer: selects an identity ONLY from its disposable Keychain.
#include <Security/Security.h>
#include <string.h>
#include <stdio.h>
typedef struct __SecCodeSigner *TestSignerRef;
extern OSStatus SecCodeSignerCreate(CFDictionaryRef, SecCSFlags, TestSignerRef *);
extern OSStatus SecCodeSignerAddSignature(TestSignerRef, SecStaticCodeRef, SecCSFlags);
int main(int argc,char **argv) {
 if(argc!=3 || strncmp(argv[1],"/tmp/dorkos-keychain-acl.",strlen("/tmp/dorkos-keychain-acl."))!=0) return 2;
 SecKeychainSetUserInteractionAllowed(false);
 SecKeychainRef keychain=NULL;OSStatus s=SecKeychainOpen(argv[1],&keychain);
 CFTypeRef identity=NULL;SecStaticCodeRef code=NULL;TestSignerRef signer=NULL;
 if(!s){
  const void *chainValues[]={keychain};CFArrayRef chains=CFArrayCreate(NULL,chainValues,1,&kCFTypeArrayCallBacks);
  const void *keys[]={kSecClass,kSecMatchSearchList,kSecReturnRef,kSecMatchLimit};
  const void *values[]={kSecClassIdentity,chains,kCFBooleanTrue,kSecMatchLimitOne};
  CFDictionaryRef q=CFDictionaryCreate(NULL,keys,values,4,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  s=SecItemCopyMatching(q,&identity);CFRelease(q);CFRelease(chains);
 }
 if(!s){
  const void *keys[]={CFSTR("signer"),CFSTR("identifier"),CFSTR("timestamp-required")};
  const void *values[]={identity,CFSTR("ai.dorkos.security-review-test"),kCFBooleanFalse};
  CFDictionaryRef p=CFDictionaryCreate(NULL,keys,values,3,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  s=SecCodeSignerCreate(p,0,&signer);CFRelease(p);
 }
 CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8*)argv[2],strlen(argv[2]),false);
 if(!s)s=SecStaticCodeCreateWithPath(url,0,&code);
 if(!s)s=SecCodeSignerAddSignature(signer,code,0);
 printf("Disposable certificate signing status=%d\n",(int)s);
 if(signer)CFRelease(signer);if(code)CFRelease(code);if(identity)CFRelease(identity);if(keychain)CFRelease(keychain);CFRelease(url);
 return s?1:0;
}
