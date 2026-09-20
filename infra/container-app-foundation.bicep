@description('Authenticated dashboard evaluation infrastructure. Does not expose an application or change existing Function/storage networking.')
param location string = resourceGroup().location
param environmentName string = 'cae-sdk-js-worker'
param virtualNetworkName string = 'vnet-sdk-js-worker'
param networkSecurityGroupName string = 'nsg-sdk-js-worker'
param identityName string = 'id-sdk-js-worker'
param registryName string = 'acrsdkjsworker2807'
param storageName string = 'stsdkjsworker2807'
param addressPrefix string = '10.83.65.0/24'

var tags = {
  purpose: 'authenticated-dashboard-evaluation'
  owner: 'jialinhuang'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: networkSecurityGroupName
  location: location
  tags: tags
  properties: { securityRules: [] }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: addressPrefix
          networkSecurityGroup: { id: nsg.id }
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    publicNetworkAccess: 'Enabled'
    vnetConfiguration: {
      internal: false
      infrastructureSubnetId: '${network.id}/subnets/container-apps'
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    appLogsConfiguration: { destination: 'azure-monitor' }
    peerAuthentication: { mtls: { enabled: true } }
    peerTrafficConfiguration: { encryption: { enabled: true } }
    zoneRedundant: false
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'acr-pull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource activity 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobs
  name: 'activity'
}
resource activityRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(activity.id, identity.id, 'activity-contributor')
  scope: activity
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

output environmentDomain string = environment.properties.defaultDomain
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output registryHost string = registry.properties.loginServer
