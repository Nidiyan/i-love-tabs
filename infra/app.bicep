param location string = resourceGroup().location

@minLength(2)
@maxLength(24)
param appName string = 'i-love-tabs'

param registryName string

@description('Full ACR image reference, preferably repository@sha256:digest.')
param image string

@description('Client ID of a separate single-tenant Entra web app registration for tester sign-in.')
param entraClientId string

@secure()
@description('Web app client secret VALUE. Used only for initial provisioning/rotation, never by GitHub Actions.')
param entraClientSecret string

@description('Tenant-local USER object IDs allowed to use the app (not emails or application IDs).')
@minLength(1)
@maxLength(12)
param testerObjectIds array

@description('Object ID of the GitHub deployment service principal, distinct from the tester sign-in registration.')
param deployPrincipalId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: '${appName}-env'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${appName}-pull'
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Enable external access only AFTER the auth child resource is deployed.
        external: false
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'entra-client-secret'
          value: entraClientSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'i-love-tabs'
          image: image
          env: [
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'PYTHON'
              value: '/opt/venv/bin/python3'
            }
          ]
          resources: {
            cpu: 1
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Startup'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 5
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 3000
              }
              periodSeconds: 10
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureActiveDirectory'
      excludedPaths: []
    }
    httpSettings: {
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: entraClientId
          clientSecretSettingName: 'entra-client-secret'
        }
        validation: {
          allowedAudiences: [
            entraClientId
            'api://${entraClientId}'
          ]
          defaultAuthorizationPolicy: {
            allowedPrincipals: {
              identities: testerObjectIds
            }
          }
        }
      }
    }
  }
}

resource deployRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, deployPrincipalId, 'Contributor')
  scope: app
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output appId string = app.id
output internalHostname string = app.properties.configuration.ingress.fqdn
output authConfigId string = auth.id
