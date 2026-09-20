@description('Provisioning-only, private personal R&D experiment. Does not deploy the dashboard API.')
param location string = resourceGroup().location

param environmentName string = 'cae-sdk-js-worker-poc'
param appName string = 'ca-sdk-js-worker-poc'
param virtualNetworkName string = 'vnet-sdk-js-worker-poc'
param networkSecurityGroupName string = 'nsg-sdk-js-worker-poc'

@description('Isolated address space; no peering, VPN or corporate routing is configured.')
param addressPrefix string = '10.83.64.0/24'

var tags = {
  purpose: 'individual-rd-provisioning-only'
  owner: 'jialinhuang'
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: networkSecurityGroupName
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [addressPrefix]
    }
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
    publicNetworkAccess: 'Disabled'
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: '${network.id}/subnets/container-apps'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: { destination: 'azure-monitor' }
    peerAuthentication: { mtls: { enabled: true } }
    peerTrafficConfiguration: { encryption: { enabled: true } }
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
    }
    template: {
      containers: [
        {
          name: 'provisioning-probe'
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

output containerAppName string = app.name
output managedEnvironmentId string = environment.id
output publicNetworkAccess string = environment.properties.publicNetworkAccess
