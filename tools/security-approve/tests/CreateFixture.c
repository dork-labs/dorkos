#include "../ExactAccess.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if(argc != 4) return 2;
    SecKeychainRef keychain=NULL; SecAccessRef acl=NULL;
    const char *password="disposable-keychain-password";
    SecKeychainSetUserInteractionAllowed(false);
    OSStatus s;
    if(access(argv[1],F_OK)==0) s=SecKeychainOpen(argv[1],&keychain);
    else s=SecKeychainCreate(argv[1],(UInt32)strlen(password),password,false,NULL,&keychain);
    SecKeychainStatus state;
    if(!s)s=SecKeychainGetStatus(keychain,&state);
    if(!s)s=DorkExactAccess(argv[2],argv[3],&acl);
    if(!s) {
        const void *keys[]={kSecClass,kSecAttrService,kSecAttrAccount,kSecValueData,kSecAttrAccess,kSecUseKeychain,kSecReturnRef};
        CFDataRef data=CFDataCreate(NULL,(const UInt8 *)"disposable-not-an-app-key",25);
        const void *values[]={kSecClassGenericPassword,CFSTR("ai.dorkos.security-review-test"),CFSTR("disposable"),data,acl,keychain,kCFBooleanTrue};
        CFDictionaryRef attrs=CFDictionaryCreate(NULL,keys,values,7,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
        CFTypeRef item=NULL;s=SecItemAdd(attrs,&item);
        if(!s){
            SecKeychainRef actual=NULL;s=SecKeychainItemCopyKeychain((SecKeychainItemRef)item,&actual);
            char got[4096],want[4096],actualReal[4096];UInt32 length=sizeof(got);
            if(!s)s=SecKeychainGetPath(actual,&length,got);
            if(!s && (!realpath(argv[1],want)||!realpath(got,actualReal)||strcmp(want,actualReal)))s=errSecParam;
            if(actual)CFRelease(actual);
        }
        if(item)CFRelease(item);CFRelease(attrs);CFRelease(data);
    }
    if(acl)CFRelease(acl);if(keychain)CFRelease(keychain);
    printf("Disposable fixture status=%d\n",(int)s);return s?1:0;
}
