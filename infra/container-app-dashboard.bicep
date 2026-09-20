@description('Deploy only an image containing the authenticated Azure runtime. Leave ingress disabled until Entra federation, callback and assigned-user access are configured.')
param image string
param appName string = 'ca-sdk-js-worker'
param environmentName string = 'cae-sdk-js-worker'
param identityName string = 'id-sdk-js-worker'
param registryName string = 'acrsdkjsworker2807'
param location string = resourceGroup().location
param enableIngress bool = false
@minValue(0)
@maxValue(1)
param minReplicas int = 0

@description('Non-secret environment configuration for the authenticated runtime. Never pass credentials in this array.')
param runtimeEnvironment array

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: { purpose: 'authenticated-dashboard-evaluation', owner: 'jialinhuang' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: enableIngress ? {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      } : null
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'dashboard'
          image: image
          env: runtimeEnvironment
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            {
              type: 'Startup'
              tcpSocket: { port: 8080 }
              initialDelaySeconds: 2
              periodSeconds: 5
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              tcpSocket: { port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
      }
    }
  }
}

output containerAppName string = app.name
output expectedOrigin string = 'https://${appName}.${environment.properties.defaultDomain}'
