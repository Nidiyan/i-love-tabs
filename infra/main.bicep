targetScope = 'subscription'

@description('Azure region supporting Container Apps Consumption.')
param location string

@minLength(2)
@maxLength(24)
param appName string = 'i-love-tabs'

@description('Globally unique, lowercase alphanumeric registry name.')
@minLength(5)
@maxLength(50)
param registryName string

@description('Object ID of the GitHub deployment service principal (not its client ID).')
param deployPrincipalId string

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${appName}-rg'
  location: location
}

module resources './resources.bicep' = {
  name: '${appName}-foundation'
  scope: group
  params: {
    location: location
    appName: appName
    registryName: registryName
    deployPrincipalId: deployPrincipalId
  }
}

output resourceGroup string = group.name
output registryLoginServer string = resources.outputs.registryLoginServer
output pullIdentityId string = resources.outputs.pullIdentityId
output environmentId string = resources.outputs.environmentId
