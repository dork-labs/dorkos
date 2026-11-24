{
  'targets': [{
    'target_name': 'custody_inbox',
    # The witness runs in node.exe. Keep this C11 target free of the optional C++ host-name shim.
    'win_delay_load_hook': 'false',
    'sources': ['directory-binding.c', 'private-directory.c'],
    'defines': ['NAPI_VERSION=8', '_WIN32_WINNT=0x0a00'],
    'libraries': ['Advapi32.lib'],
    'msvs_settings': {
      'VCCLCompilerTool': {
        'WarningLevel': 4,
        'WarnAsError': 'true',
        'AdditionalOptions': ['/std:c11']
      }
    }
  }]
}
