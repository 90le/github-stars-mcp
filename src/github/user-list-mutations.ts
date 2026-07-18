export const CREATE_USER_LIST =
  `mutation CreateUserList($name: String!, $description: String, $isPrivate: Boolean!, $clientMutationId: String!) {
  createUserList(input: { name: $name, description: $description, isPrivate: $isPrivate, clientMutationId: $clientMutationId }) {
    list { id name slug description isPrivate createdAt updatedAt lastAddedAt }
    clientMutationId
  }
}` as const;

export const UPDATE_USER_LIST =
  `mutation UpdateUserList($listId: ID!, $name: String, $description: String, $isPrivate: Boolean, $clientMutationId: String!) {
  updateUserList(input: { listId: $listId, name: $name, description: $description, isPrivate: $isPrivate, clientMutationId: $clientMutationId }) {
    list { id name slug description isPrivate createdAt updatedAt lastAddedAt }
    clientMutationId
  }
}` as const;

export const DELETE_USER_LIST =
  `mutation DeleteUserList($listId: ID!, $clientMutationId: String!) {
  deleteUserList(input: { listId: $listId, clientMutationId: $clientMutationId }) {
    clientMutationId
  }
}` as const;

export const SET_REPOSITORY_LISTS =
  `mutation UpdateUserListsForItem($itemId: ID!, $listIds: [ID!]!, $clientMutationId: String!) {
  updateUserListsForItem(input: { itemId: $itemId, listIds: $listIds, clientMutationId: $clientMutationId }) {
    item { __typename ... on Repository { id } }
    lists { id }
    clientMutationId
  }
}` as const;
