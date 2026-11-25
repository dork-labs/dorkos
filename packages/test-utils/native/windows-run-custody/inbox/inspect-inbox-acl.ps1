# Independent Windows PowerShell 5.1 observer for the inbox witness.
param([string]$Directory, [string]$Record)

$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('ACL observer: current identity')
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'

[Console]::Error.WriteLine('ACL observer: directory')
$dir = [System.IO.Directory]::GetAccessControl($Directory, $sections)
[Console]::Error.WriteLine('ACL observer: record')
$file = [System.IO.File]::GetAccessControl($Record, $sections)

[Console]::Error.WriteLine('ACL observer: checking rules')
if ($dir.GetOwner($sidType).Value -ne $user -or !$dir.AreAccessRulesProtected) {
    throw 'Unexpected directory owner or inheritance'
}
foreach ($acl in @($dir, $file)) {
    $rules = @($acl.GetAccessRules($true, $true, $sidType))
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $user -or $rules[0].AccessControlType -ne 'Allow') {
        throw 'Unexpected metadata ACL'
    }
}
$childRules = @($file.GetAccessRules($true, $true, $sidType))
if (!$childRules[0].IsInherited) { throw 'Expected the record to inherit its private ACL' }
[Console]::WriteLine('private directory and record ACLs observed')
