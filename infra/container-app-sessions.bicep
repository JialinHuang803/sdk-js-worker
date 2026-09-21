@description('Add private authentication storage without changing activity data or resource networking.')
param storageName string = 'stsdkjsworker2807'
param identityName string = 'id-sdk-js-worker'
param containerName string = 'sessions'

@description('Enable only after confirming the account has no existing lifecycle policy. Otherwise merge these prefix-scoped rules into the existing policy.')
param createLifecyclePolicy bool = false

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}
resource sessions 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}
resource sessionRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sessions.id, identity.id, 'session-contributor')
  scope: sessions
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = if (createLifecyclePolicy) {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-session-records'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${containerName}/sessions/']
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 8 }
              }
            }
          }
        }
        {
          name: 'expire-pending-signins'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${containerName}/pending/']
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 1 }
              }
            }
          }
        }
      ]
    }
  }
}

output sessionContainer string = sessions.name
